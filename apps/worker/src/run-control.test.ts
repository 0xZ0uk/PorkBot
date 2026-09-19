import { Effect, Fiber } from "effect";
import { emulatorAgentRuntimeLayer } from "@porkbot/adapters";
import type { EmulatorStep } from "@porkbot/adapters";
import { createRepositories } from "@porkbot/db";
import type { FencedRunPatch, RunLease, RunRecord, SystemRepositories } from "@porkbot/db";
import {
  consumeRunSession,
  createRunEventRecorder,
  createToolDispatcher,
  DEFAULT_STOP_REASON,
  liveRunsLayer,
  pumpRunCommands,
  withLiveRun,
} from "@porkbot/effect";
import type {
  PendingSteer,
  RunCommandSource,
  RunStartRequest,
  ToolCallAdmission,
  ToolCallLedger,
  ToolOutcome,
} from "@porkbot/effect";
import type { RunEvent } from "@porkbot/core";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createRunExecutor } from "./run-execution.ts";
import type { RunExecution } from "./jobs/run-execute.ts";

/**
 * Steering and stopping a live run (slice 6.7, stories 20 and 21), through the
 * shipped execution harness and the emulator runtime.
 *
 * Each test composes exactly what the worker's run path composes: the durable
 * command source beside the session (`pumpRunCommands`), the single event
 * consumer (`consumeRunSession`), and the executor that settles the row from
 * the outcome. The source is scripted rather than a database so the suite
 * stays offline and deterministic; `@porkbot/db`'s own suites prove the
 * statements behind the same seam.
 *
 * The properties pinned here are the acceptance criteria: a steer reaches the
 * live run and changes what follows it; a stop cancels promptly — including a
 * tool call in flight, which must not commit — settles the run `cancelled`
 * with its lease released, and does not fire twice; and a session that has
 * already ended neither receives another command nor reports a second terminal
 * event.
 */

const runId = "run-1";

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: runId,
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

function startRequest(): RunStartRequest {
  return {
    runId,
    threadId: "thread-1",
    startSeq: 1,
    connection: { baseUrl: "https://model.example.test/v1", credentialName: "model-key" },
    model: "test-model",
    messages: [{ role: "user", content: "write the report" }],
  };
}

function memoryLedger(): ToolCallLedger & { readonly admitted: ToolCallAdmission[] } {
  const admitted: ToolCallAdmission[] = [];
  const settled = new Map<string, ToolOutcome>();

  return {
    admitted,
    async begin(call): Promise<ToolCallAdmission> {
      const outcome = settled.get(call.callId) ?? { status: "started" };
      admitted.push(outcome);

      return outcome;
    },
    async complete(call, result): Promise<ToolOutcome> {
      const outcome: ToolOutcome = { status: "completed", result };
      settled.set(call.callId, outcome);

      return outcome;
    },
    async fail(call, error): Promise<ToolOutcome> {
      const outcome: ToolOutcome = { status: "failed", error };
      settled.set(call.callId, outcome);

      return outcome;
    },
  };
}

interface ControlRun {
  readonly recorded: readonly RunEvent[];
  readonly updates: FakeRunner["updates"];
}

/**
 * Runs one scripted session the way the worker does: the command pump beside
 * the session, one consumer for the events, and the outcome settled by the
 * real executor.
 */
async function runControlled(input: {
  readonly script: readonly EmulatorStep[];
  readonly source: RunCommandSource;
  readonly tools?: ReturnType<typeof createToolDispatcher> | undefined;
  readonly onEvent?: (event: RunEvent) => void;
}): Promise<ControlRun> {
  const runner = fakeRepositories();
  const recorded: RunEvent[] = [];

  const execute = createRunExecutor({
    heartbeatIntervalMs: 5,
    work: (execution) =>
      withLiveRun(
        execution.run.id,
        emulatorAgentRuntimeLayer(startRequest(), input.script, {
          ...(input.tools === undefined ? {} : { tools: input.tools }),
        }),
        (session) =>
          Effect.gen(function* () {
            const pump = yield* pumpRunCommands(session, {
              runId: execution.run.id,
              source: input.source,
              pollIntervalMs: 1,
            }).pipe(Effect.fork);

            const recorder = createRunEventRecorder();
            const outcome = yield* consumeRunSession(session, (event) =>
              Effect.sync(() => {
                execution.progress.note(event);
                const recordedEvent = recorder.record(event);
                recorded.push(recordedEvent);
                input.onEvent?.(recordedEvent);
              }),
            );

            yield* Fiber.join(pump);

            return outcome;
          }),
      ).pipe(Effect.provide(liveRunsLayer)),
  });

  await execute(executionFor(runner));

  return { recorded, updates: runner.updates };
}

function sourceOf(
  steers: () => readonly PendingSteer[],
  stop: () => boolean = () => false,
): RunCommandSource {
  return {
    async claimSteers() {
      return steers();
    },
    async stopRequested() {
      return stop();
    },
  };
}

describe("steering a live run", () => {
  it("delivers the operator's message and the run's response reflects it", async () => {
    const script: readonly EmulatorStep[] = [
      { kind: "token.delta", messageId: "assistant-1", delta: "Starting the report." },
      { kind: "await.steer" },
      { kind: "token.delta", messageId: "assistant-1", delta: " Correcting course." },
      { kind: "run.completed", messageId: "assistant-1" },
    ];

    let claimed = false;
    const source = sourceOf(() => {
      if (claimed) {
        return [];
      }

      claimed = true;

      return [{ messageId: "message-1", text: "focus on the summary" }];
    });

    const { recorded, updates } = await runControlled({ script, source });

    expect(recorded.map((event) => event.type)).toEqual([
      "run.started",
      "token.delta",
      "run.steered",
      "token.delta",
      "run.completed",
    ]);

    expect(recorded[2]).toMatchObject({
      type: "run.steered",
      messageId: "message-1",
      text: "focus on the summary",
    });

    const deltas = recorded
      .filter((event) => event.type === "token.delta")
      .map((event) => event.delta);
    expect(deltas).toEqual(["Starting the report.", " Correcting course."]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ patch: { status: "completed", release: true } });
  });

  it("claims each steer once, so a double click does not steer twice", async () => {
    const script: readonly EmulatorStep[] = [
      { kind: "await.steer" },
      { kind: "run.completed", messageId: "assistant-1" },
    ];

    // The source models the durable claim: the row is handed out once, no
    // matter how many polls see it.
    const pending: PendingSteer[] = [{ messageId: "message-1", text: "first" }];
    const source = sourceOf(() => pending.splice(0));

    const { recorded } = await runControlled({ script, source });

    expect(recorded.filter((event) => event.type === "run.steered")).toHaveLength(1);
  });
});

describe("stopping a live run", () => {
  it("cancels promptly, releases the lease and never commits the call in flight", async () => {
    let interrupted = false;
    let stop = false;
    const ledger = memoryLedger();

    const tools = createToolDispatcher({
      registrations: [
        {
          name: "shell",
          description: "run a shell command",
          parameters: { type: "object" },
          maxDurationMs: 30_000,
          execute: () =>
            Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
        },
      ],
      ledger,
      leaseTtlMs: 120_000,
      heartbeat: Effect.void,
    });

    const script: readonly EmulatorStep[] = [
      {
        kind: "tool.immediate",
        callId: "call-1",
        tool: "shell",
        arguments: { command: "sleep 3600" },
      },
      { kind: "run.completed" },
    ];

    const { recorded, updates } = await runControlled({
      script,
      source: sourceOf(
        () => [],
        () => stop,
      ),
      tools,
      onEvent: (event) => {
        if (event.type === "tool.requested") {
          stop = true;
        }
      },
    });

    expect(recorded.map((event) => event.type)).toEqual([
      "run.started",
      "tool.requested",
      "run.cancelled",
    ]);
    expect(recorded.at(-1)).toMatchObject({ type: "run.cancelled", reason: DEFAULT_STOP_REASON });
    expect(interrupted).toBe(true);

    // Nothing was committed for the call: no completion event, and the durable
    // ledger still holds an open claim that reclaim reconciles rather than a
    // result a retry would replay.
    expect(recorded.some((event) => event.type === "tool.completed")).toBe(false);
    expect(ledger.admitted).toEqual([{ status: "started" }]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      patch: {
        status: "cancelled",
        attempt: "cancelled",
        completed: true,
        release: true,
        settleInFlight: expect.any(String),
      },
    });
  });

  it("cancels once when the stop mark is already set, as a resumed run finds it", async () => {
    // The mark is true from the first tick, which is what a reclaimed (resumed)
    // run sees: the request outlives the worker that was holding the lease, and
    // the new session cancels immediately instead of running on.
    const script: readonly EmulatorStep[] = [
      { kind: "token.delta", messageId: "assistant-1", delta: "looping" },
      { kind: "await.steer" },
    ];

    const { recorded } = await runControlled({
      script,
      source: sourceOf(
        () => [],
        () => true,
      ),
    });

    expect(recorded.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
    expect(recorded.map((event) => event.type)).toEqual([
      "run.started",
      "token.delta",
      "run.cancelled",
    ]);
  });

  it("does not deliver a steer after the run has already ended", async () => {
    const script: readonly EmulatorStep[] = [{ kind: "run.completed", messageId: "assistant-1" }];

    // The steer becomes claimable only after the terminal event, the way a
    // send that raced a finished run lands in the table too late for any live
    // session to claim it. The pump has ended with the session's mailbox, so
    // the row stays unclaimed rather than being replayed into a later run.
    let finished = false;

    const { recorded, updates } = await runControlled({
      script,
      source: sourceOf(() => (finished ? [{ messageId: "message-1", text: "too late" }] : [])),
      onEvent: (event) => {
        if (event.type === "run.completed") {
          finished = true;
        }
      },
    });

    expect(recorded.map((event) => event.type)).toEqual(["run.started", "run.completed"]);
    expect(updates[0]).toMatchObject({ patch: { status: "completed" } });
  });
});
