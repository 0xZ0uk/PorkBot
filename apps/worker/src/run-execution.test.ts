import { Effect, Fiber, Stream } from "effect";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import { emulatorAgentRuntimeLayer } from "@porkbot/adapters";
import type { EmulatorStep } from "@porkbot/adapters";
import { createRepositories } from "@porkbot/db";
import type {
  FencedRunPatch,
  RunLease,
  RunProgressStamp,
  RunRecord,
  SystemRepositories,
} from "@porkbot/db";
import {
  consumeRunSession,
  LeaseLostError,
  LiveRuns,
  liveRunsLayer,
  withLiveRun,
} from "@porkbot/effect";
import type { RunStartRequest } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createRunExecutor } from "./run-execution.ts";
import type { RunExecution } from "./jobs/run-execute.ts";

/**
 * The execution harness: the frame a run runs inside. These tests drive it with
 * a work effect the test owns, so the four outcomes — completed, failed, fence
 * lost, and a subscriber leaving — are observed through the writes the harness
 * makes and the events the run still produces.
 */

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    userId: "user-1",
    status: "running",
    trigger: "message",
    error: null,
    errorCode: null,
    leaseOwner: "job-1",
    leaseFence: 1,
    leaseExpiresAt: new Date(120_000),
    stopRequestedAt: null,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    currentStep: null,
    currentStepTool: null,
    stalledAt: null,
    checkpoint: {},
    clientNonce: "nonce-1",
    sourceMessageId: null,
    startedAt: new Date(0),
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

interface FakeRunner {
  readonly repositories: SystemRepositories;
  readonly heartbeats: Array<{ readonly lease: RunLease; readonly progress: RunProgressStamp }>;
  readonly updates: Array<{ readonly lease: RunLease; readonly patch: FencedRunPatch }>;
  readonly abandoned: Array<{ readonly fence: number; readonly reason: string }>;
}

function fakeRepositories(options: { readonly heartbeatFails?: boolean } = {}): FakeRunner {
  const heartbeats: Array<{ lease: RunLease; progress: RunProgressStamp }> = [];
  const updates: Array<{ lease: RunLease; patch: FencedRunPatch }> = [];
  const abandoned: Array<{ fence: number; reason: string }> = [];

  const actor = { kind: "system" as const, spaceId: "space-1", jobId: "job-1" };
  const repositories = createRepositories(actor, {
    async query<Row>() {
      return { rows: [] as readonly Row[] };
    },
  });

  repositories.runs.heartbeat = async (_id, lease, progress) => {
    heartbeats.push({ lease, progress });

    if (options.heartbeatFails === true) {
      throw new LeaseLostError("run-1");
    }

    return runRecord();
  };
  repositories.runs.update = async (_id, lease, patch) => {
    updates.push({ lease, patch });

    return runRecord();
  };
  repositories.runs.abandonAttempt = async (_id, fence, reason) => {
    abandoned.push({ fence, reason });

    return true;
  };

  return { repositories, heartbeats, updates, abandoned };
}

function executionFor(runner: FakeRunner, run: RunRecord = runRecord()): RunExecution {
  return {
    actor: { kind: "system", spaceId: "space-1", jobId: "job-1" },
    run,
    repositories: runner.repositories,
    logger: createLogger({ service: "@porkbot/worker", write: () => {} }),
    resumed: false,
  };
}

function startRequest(runId: string): RunStartRequest {
  return {
    runId,
    threadId: "thread-1",
    startSeq: 1,
    connection: { baseUrl: "https://model.example.test/v1", credentialName: "model-key" },
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  };
}

describe("the run execution harness", () => {
  it("settles a completed run and its attempt, with the lease renewed", async () => {
    const runner = fakeRepositories();
    const execute = createRunExecutor({
      work: () => Effect.succeed({ status: "completed" } as const),
      heartbeatIntervalMs: 5,
    });

    await execute(executionFor(runner));

    expect(runner.updates).toHaveLength(1);
    expect(runner.updates[0]).toMatchObject({
      lease: { owner: "job-1", fence: 1 },
      patch: {
        status: "completed",
        completed: true,
        attempt: "completed",
        release: true,
      },
    });
    expect(runner.heartbeats.length).toBeGreaterThan(0);
    expect(runner.abandoned).toEqual([]);
  });

  it("stamps each heartbeat with the step and progress the work reported", async () => {
    const runner = fakeRepositories();
    const execute = createRunExecutor({
      heartbeatIntervalMs: 5,
      work: (execution) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            execution.progress.note({
              schemaVersion: RUN_EVENT_SCHEMA_VERSION,
              seq: 2,
              threadId: "thread-1",
              runId: "run-1",
              type: "tool.requested",
              callId: "call-1",
              tool: "shell",
              arguments: {},
            });
          });
          yield* Effect.sleep("20 millis");

          return { status: "completed" } as const;
        }),
    });

    await execute(executionFor(runner));

    expect(
      runner.heartbeats.some(
        (beat) =>
          beat.progress.progressed &&
          beat.progress.step !== null &&
          beat.progress.step.kind === "working" &&
          beat.progress.step.tool === "shell",
      ),
    ).toBe(true);
    // A beat after the event has been stamped reports no progress, which is
    // what makes a silent run's stall detectable.
    expect(runner.heartbeats.length).toBeGreaterThan(1);
    expect(runner.heartbeats.at(-1)?.progress.progressed).toBe(false);
  });

  it("settles a stopped session as cancelled with its attempt and releases the lease", async () => {
    const runner = fakeRepositories();
    const execute = createRunExecutor({
      work: () => Effect.succeed({ status: "cancelled", reason: "the operator stopped this run" }),
      heartbeatIntervalMs: 5,
    });

    await execute(executionFor(runner));

    expect(runner.updates).toHaveLength(1);
    expect(runner.updates[0]).toMatchObject({
      patch: {
        status: "cancelled",
        errorCode: "cancelled",
        completed: true,
        attempt: "cancelled",
        release: true,
      },
    });
    expect(runner.abandoned).toEqual([]);
  });

  it("settles a terminal run.failed event as a failed run", async () => {
    const runner = fakeRepositories();
    const execute = createRunExecutor({
      work: () =>
        Effect.succeed({ status: "failed", error: "the model endpoint is gone", code: "gone" }),
      heartbeatIntervalMs: 5,
    });

    await execute(executionFor(runner));

    expect(runner.updates).toHaveLength(1);
    expect(runner.updates[0]).toMatchObject({
      patch: {
        status: "failed",
        error: "the model endpoint is gone",
        errorCode: "gone",
        attempt: "failed",
        release: true,
      },
    });
  });

  it("settles a failed run with its attempt rather than leaving it running", async () => {
    const runner = fakeRepositories();
    const execute = createRunExecutor({
      work: () => Effect.fail(new Error("the computer is gone")),
      heartbeatIntervalMs: 5,
    });

    await execute(executionFor(runner));

    expect(runner.updates).toHaveLength(1);
    expect(runner.updates[0]).toMatchObject({
      patch: {
        status: "failed",
        error: "the computer is gone",
        attempt: "failed",
      },
    });
    expect(runner.abandoned).toEqual([]);
  });

  it("interrupts in-flight work on a lost lease, writes no run state, and abandons the attempt", async () => {
    const runner = fakeRepositories({ heartbeatFails: true });
    let interrupted = false;
    const execute = createRunExecutor({
      work: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      heartbeatIntervalMs: 5,
    });

    await execute(executionFor(runner));

    expect(interrupted).toBe(true);
    expect(runner.updates).toEqual([]);
    expect(runner.abandoned).toHaveLength(1);
    expect(runner.abandoned[0]).toMatchObject({ fence: 1 });
  });

  it("keeps the run alive when a subscriber of its events is interrupted", async () => {
    const runner = fakeRepositories();
    const script: readonly EmulatorStep[] = [
      { kind: "await.steer" },
      { kind: "run.completed", messageId: "assistant-1" },
    ];
    const observed: string[] = [];

    const execute = createRunExecutor({
      heartbeatIntervalMs: 5,
      work: (execution) =>
        withLiveRun(
          execution.run.id,
          emulatorAgentRuntimeLayer(startRequest(execution.run.id), script),
          (session) =>
            Effect.gen(function* () {
              const liveRuns = yield* LiveRuns;
              const subscriber = yield* session.events.pipe(
                Stream.tap((event) => Effect.sync(() => observed.push(event.type))),
                Stream.runDrain,
                Effect.fork,
              );

              yield* Effect.sleep("5 millis");
              yield* Fiber.interrupt(subscriber);

              // The run is worker-owned, so a dead subscriber costs the run
              // nothing: the steer reaches it and the terminal event follows.
              yield* liveRuns.dispatch(execution.run.id, {
                type: "steer",
                messageId: "message-1",
                text: "continue",
              });

              return yield* consumeRunSession(session, (event) =>
                Effect.sync(() => {
                  observed.push(event.type);
                }),
              );
            }),
        ).pipe(Effect.provide(liveRunsLayer)),
    });

    await execute(executionFor(runner));

    expect(runner.updates).toHaveLength(1);
    expect(runner.updates[0]).toMatchObject({ patch: { status: "completed" } });
    expect(observed).not.toContain("run.cancelled");
    expect(observed.at(-1)).toBe("run.completed");
  });
});
