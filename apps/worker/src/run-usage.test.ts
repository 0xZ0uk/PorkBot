import { Effect } from "effect";
import { emulatorAgentRuntimeLayer } from "@porkbot/adapters";
import type { EmulatorStep } from "@porkbot/adapters";
import { createRepositories } from "@porkbot/db";
import type { FencedRunPatch, RunLease, RunRecord, SystemRepositories } from "@porkbot/db";
import { consumeRunSession, LiveRuns, liveRunsLayer, withLiveRun } from "@porkbot/effect";
import type { RunStartRequest, RunUsage, UsageRecorder } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createRunExecutor } from "./run-execution.ts";
import type { RunExecution } from "./jobs/run-execute.ts";

/**
 * Usage survives the run it belongs to (slice 8.8, story 34).
 *
 * The acceptance criterion is "usage survives run failure and cancellation
 * (partial usage is recorded)", and that is a property of *when* the report
 * happens: the run's runtime reports each completed turn beside the event
 * stream, not at settlement, so a run that later fails or is stopped keeps
 * what its earlier turns spent. This suite drives the shipped executor and the
 * shipped emulator runtime and asserts exactly that — the recorder holds the
 * turn after a `run.failed`, and after the operator stops a run mid-turn.
 *
 * A recorder that refuses a write must not change the run's outcome; the
 * policy lives in `reportUsage` and the assertion here is that the run still
 * settles by its own script rather than by the ledger's health.
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
    notifiedAt: null,
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
  readonly updates: Array<{ readonly lease: RunLease; readonly patch: FencedRunPatch }>;
}

function fakeRepositories(): FakeRunner {
  const updates: Array<{ lease: RunLease; patch: FencedRunPatch }> = [];
  const actor = { kind: "system" as const, spaceId: "space-1", jobId: "job-1" };
  const repositories = createRepositories(actor, {
    async query<Row>() {
      return { rows: [] as readonly Row[] };
    },
  });

  repositories.runs.heartbeat = async () => runRecord();
  repositories.runs.update = async (_id, lease, patch) => {
    updates.push({ lease, patch });

    return runRecord();
  };

  return { repositories, updates };
}

function executionFor(runner: FakeRunner): RunExecution {
  return {
    actor: { kind: "system", spaceId: "space-1", jobId: "job-1" },
    run: runRecord(),
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
    messages: [{ role: "user", content: "spend some tokens, then break" }],
  };
}

interface RecordedRecorder {
  readonly recorder: UsageRecorder;
  readonly usage: RunUsage[];
  /** Resolves the first time a record lands, so a stop can wait for it. */
  readonly firstRecord: Promise<void>;
}

function recordingRecorder(): RecordedRecorder {
  const usage: RunUsage[] = [];
  let markRecorded: () => void = () => undefined;
  const firstRecord = new Promise<void>((resolve) => {
    markRecorded = resolve;
  });

  return {
    usage,
    firstRecord,
    recorder: {
      record: async (record) => {
        usage.push(record);
        markRecorded();
      },
    },
  };
}

interface UsageRun {
  readonly usage: readonly RunUsage[];
  readonly updates: FakeRunner["updates"];
}

/**
 * Runs one script under the shipped executor with a usage recorder attached.
 * `stopAfterFirstRecord` dispatches the operator's stop once the first turn's
 * usage has landed, so the cancellation path is deterministic rather than a
 * sleep race.
 */
async function runWithUsage(
  script: readonly EmulatorStep[],
  options: { readonly stopAfterFirstRecord?: boolean } = {},
): Promise<UsageRun> {
  const runner = fakeRepositories();
  const recorded = recordingRecorder();

  const execute = createRunExecutor({
    heartbeatIntervalMs: 5,
    work: (execution) =>
      withLiveRun(
        execution.run.id,
        emulatorAgentRuntimeLayer(startRequest(execution.run.id), script, {
          usage: recorded.recorder,
        }),
        (session) =>
          Effect.gen(function* () {
            if (options.stopAfterFirstRecord === true) {
              const liveRuns = yield* LiveRuns;

              yield* Effect.fork(
                Effect.gen(function* () {
                  yield* Effect.tryPromise(() => recorded.firstRecord);
                  yield* liveRuns.dispatch(execution.run.id, {
                    type: "stop",
                    reason: "operator stopped it",
                  });
                }),
              );
            }

            return yield* consumeRunSession(session, () => Effect.void);
          }),
      ).pipe(Effect.provide(liveRunsLayer)),
  });

  await execute(executionFor(runner));

  return { usage: recorded.usage, updates: runner.updates };
}

describe("usage across a run's life", () => {
  it("keeps a completed turn's usage when the run fails later", async () => {
    const { usage, updates } = await runWithUsage([
      {
        kind: "usage",
        provider: "openai",
        model: "test-model",
        inputTokens: 800,
        outputTokens: 120,
      },
      { kind: "run.failed", error: "the provider dropped the stream" },
    ]);

    expect(usage).toEqual([
      {
        runId: "run-1",
        provider: "openai",
        model: "test-model",
        inputTokens: 800,
        outputTokens: 120,
      },
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.patch).toMatchObject({ status: "failed" });
  });

  it("keeps a completed turn's usage when the operator stops the run", async () => {
    const { usage, updates } = await runWithUsage(
      [
        {
          kind: "usage",
          provider: "openai",
          model: "test-model",
          inputTokens: 50,
          outputTokens: 10,
        },
        { kind: "await.steer" },
      ],
      { stopAfterFirstRecord: true },
    );

    expect(usage).toEqual([
      {
        runId: "run-1",
        provider: "openai",
        model: "test-model",
        inputTokens: 50,
        outputTokens: 10,
      },
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.patch).toMatchObject({ status: "cancelled" });
  });

  it("records a turn whose provider reported nothing as not reported", async () => {
    const { usage } = await runWithUsage([
      { kind: "usage" },
      { kind: "run.completed", messageId: "assistant-1" },
    ]);

    expect(usage).toEqual([
      { runId: "run-1", provider: null, model: null, inputTokens: null, outputTokens: null },
    ]);
  });
});
