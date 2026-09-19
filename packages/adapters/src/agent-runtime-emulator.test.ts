import { Cause, Deferred, Effect, Exit, Fiber, Option, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { parseRunEvent } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import {
  AgentRuntime,
  createToolDispatcher,
  fenced,
  LiveRuns,
  liveRunsLayer,
  processSingleton,
  withLiveRun,
} from "@porkbot/effect";
import type {
  LiveRunsShape,
  LiveRunsTag,
  RunSession,
  RunStartRequest,
  RunUsage,
  ToolCall,
  ToolCallAdmission,
  ToolCallLedger,
  ToolOutcome,
  UsageRecorder,
} from "@porkbot/effect";
import { LeaseLostError, RunGoneError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import { EmulatorScriptError, emulatorAgentRuntimeLayer } from "./agent-runtime-emulator.ts";
import type { EmulatorRuntimeOptions, EmulatorStep } from "./agent-runtime-emulator.ts";

/**
 * The duplex run seam driven end to end through the shipped offline runtime
 * (PRD decision 13; issue #47).
 *
 * Every test below talks to `AgentRuntimeLayer` and `RunSession` and imports
 * the orchestrator (`withLiveRun`, `LiveRuns`, `fenced`) from
 * `@porkbot/effect`; the emulator is the second implementation handed to it,
 * exactly as the Pi adapter will be in slice 5.3. That is the proof the
 * orchestrator can gain a runtime without changing: it names no implementation,
 * and this suite swaps one in from outside.
 *
 * The tier is unit rather than integration because the emulator is offline and
 * deterministic — no database, no harness, no clock — yet each test drives the
 * whole path: run-scoped layer, session, registry, commands, cancellation.
 */

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

function eventTypes(events: readonly RunEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

/** Collects a session's events into an unbounded queue until the stream ends. */
function collectEvents(session: RunSession) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<RunEvent>();
    const fiber = yield* Effect.fork(
      Stream.runForEach(session.events, (event) => Queue.offer(queue, event)),
    );
    return { queue, fiber };
  });
}

/**
 * Starts one run, hands `send` the registry while it is live, and returns the
 * events the session emitted. The collector is the stream's only consumer.
 */
function driveRun(
  runId: string,
  script: readonly EmulatorStep[],
  send?: (liveRuns: LiveRunsShape) => Effect.Effect<void, RunGoneError>,
  options?: EmulatorRuntimeOptions,
): Effect.Effect<readonly RunEvent[], RunGoneError, LiveRunsTag | Scope.Scope> {
  return Effect.gen(function* () {
    const session = yield* Deferred.make<RunSession>();
    const release = yield* Deferred.make<undefined>();

    const run = yield* Effect.fork(
      withLiveRun(runId, emulatorAgentRuntimeLayer(startRequest(runId), script, options), (live) =>
        Deferred.succeed(session, live).pipe(Effect.zipRight(Deferred.await(release))),
      ),
    );

    const live = yield* Deferred.await(session);
    const { queue, fiber: collector } = yield* collectEvents(live);
    const liveRuns = yield* LiveRuns;

    if (send !== undefined) {
      yield* send(liveRuns);
    }

    yield* Fiber.join(collector);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(run);

    return Array.from(yield* Queue.takeAll(queue));
  });
}

describe("the duplex run seam", () => {
  it("delivers a steer into the live run and answers it as run.steered", async () => {
    const script: readonly EmulatorStep[] = [
      { kind: "await.steer" },
      { kind: "run.completed", messageId: "assistant-1" },
    ];

    const events = await Effect.runPromise(
      driveRun("run-1", script, (liveRuns) =>
        liveRuns.dispatch("run-1", {
          type: "steer",
          messageId: "message-1",
          text: "keep going",
        }),
      ).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    expect(eventTypes(events)).toEqual(["run.started", "run.steered", "run.completed"]);
    expect(events[1]).toMatchObject({ messageId: "message-1", text: "keep going" });
    for (const event of events) {
      expect(parseRunEvent(event).ok).toBe(true);
    }
  });

  it("resolves approval gates from approve and deny commands", async () => {
    const script: readonly EmulatorStep[] = [
      {
        kind: "tool.awaiting_approval",
        callId: "call-approve",
        tool: "send_email",
        arguments: { to: "operator@example.test" },
        result: { sent: true },
      },
      {
        kind: "tool.awaiting_approval",
        callId: "call-deny",
        tool: "delete_file",
        arguments: { path: "/tmp/report.txt" },
        result: { deleted: true },
      },
      { kind: "run.completed", messageId: "assistant-1" },
    ];

    const events = await Effect.runPromise(
      driveRun("run-1", script, (liveRuns) =>
        liveRuns.dispatch("run-1", { type: "approve", callId: "call-approve" }).pipe(
          Effect.zipRight(
            liveRuns.dispatch("run-1", {
              type: "deny",
              callId: "call-deny",
              reason: "not this time",
            }),
          ),
        ),
      ).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    expect(eventTypes(events)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "tool.requested",
      "tool.failed",
      "run.completed",
    ]);
    expect(events[2]).toMatchObject({ callId: "call-approve", result: { sent: true } });
    expect(events[4]).toMatchObject({ callId: "call-deny", error: "not this time" });
  });

  it("cancels the run on stop and reports the operator's reason", async () => {
    const script: readonly EmulatorStep[] = [{ kind: "await.steer" }];

    const events = await Effect.runPromise(
      driveRun("run-1", script, (liveRuns) =>
        liveRuns.dispatch("run-1", { type: "stop", reason: "operator stopped it" }),
      ).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    expect(eventTypes(events)).toEqual(["run.started", "run.cancelled"]);
    expect(events[1]).toMatchObject({ reason: "operator stopped it" });
  });

  it("answers a command for a run this process does not hold with RunGoneError", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const liveRuns = yield* LiveRuns;
        return yield* liveRuns
          .dispatch("run-missing", { type: "stop" })
          .pipe(Effect.timeout("1 second"), Effect.either);
      }).pipe(Effect.provide(liveRunsLayer)),
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(RunGoneError);
    }
  });

  it("answers a command for a run that already finished with RunGoneError", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* driveRun("run-1", [{ kind: "run.completed" }]);

          const liveRuns = yield* LiveRuns;
          expect(yield* liveRuns.isLive("run-1")).toBe(false);
          expect(eventTypes(events)).toEqual(["run.started", "run.completed"]);

          return yield* liveRuns
            .dispatch("run-1", { type: "stop" })
            .pipe(Effect.timeout("1 second"), Effect.either);
        }).pipe(Effect.provide(liveRunsLayer)),
      ),
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(RunGoneError);
    }
  });

  it("losing the fence interrupts the run and the adapter cancels-and-reports", async () => {
    const script: readonly EmulatorStep[] = [
      {
        kind: "tool.awaiting_approval",
        callId: "call-1",
        tool: "send_email",
        arguments: { to: "operator@example.test" },
        result: { sent: true },
      },
      { kind: "run.completed", messageId: "assistant-1" },
    ];

    const { exit, observations } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fenceLost = yield* Deferred.make<LeaseLostError>();
          const session = yield* Deferred.make<RunSession>();

          const run = fenced(
            fenceLost,
            withLiveRun("run-1", emulatorAgentRuntimeLayer(startRequest("run-1"), script), (live) =>
              Deferred.succeed(session, live).pipe(Effect.zipRight(Effect.never)),
            ),
          );

          const runFiber = yield* Effect.fork(run);
          const live = yield* Deferred.await(session);
          const { queue, fiber: collector } = yield* collectEvents(live);

          const observed: RunEvent[] = [];
          while (!observed.some((event) => event.type === "tool.requested")) {
            observed.push(yield* Queue.take(queue));
          }

          yield* Deferred.succeed(fenceLost, new LeaseLostError("run-1"));

          const runExit = yield* Fiber.await(runFiber);
          yield* Fiber.join(collector);
          observed.push(...Array.from(yield* Queue.takeAll(queue)));

          return { exit: runExit, observations: observed };
        }).pipe(Effect.provide(liveRunsLayer)),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(LeaseLostError);
      }
    }

    expect(eventTypes(observations)).toEqual(["run.started", "tool.requested", "run.cancelled"]);
    expect(observations.at(-1)).toMatchObject({ type: "run.cancelled", reason: "interrupted" });
  });

  it("keeps sessions per run: a command reaches only the run it names", async () => {
    const steered: readonly EmulatorStep[] = [
      { kind: "await.steer" },
      { kind: "run.completed", messageId: "assistant-steered" },
    ];
    const plain: readonly EmulatorStep[] = [
      { kind: "token.delta", messageId: "assistant-plain", delta: "done" },
      { kind: "run.completed", messageId: "assistant-plain" },
    ];

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstSession = yield* Deferred.make<RunSession>();
          const secondSession = yield* Deferred.make<RunSession>();
          const firstRelease = yield* Deferred.make<undefined>();

          const first = yield* Effect.fork(
            withLiveRun(
              "run-1",
              emulatorAgentRuntimeLayer(startRequest("run-1"), steered),
              (live) =>
                Deferred.succeed(firstSession, live).pipe(
                  Effect.zipRight(Deferred.await(firstRelease)),
                ),
            ),
          );
          yield* Effect.fork(
            withLiveRun("run-2", emulatorAgentRuntimeLayer(startRequest("run-2"), plain), (live) =>
              Deferred.succeed(secondSession, live).pipe(Effect.zipRight(Effect.never)),
            ),
          );

          const liveFirst = yield* Deferred.await(firstSession);
          const liveSecond = yield* Deferred.await(secondSession);
          const collectedFirst = yield* collectEvents(liveFirst);
          const collectedSecond = yield* collectEvents(liveSecond);

          const liveRuns = yield* LiveRuns;
          yield* liveRuns.dispatch("run-1", {
            type: "steer",
            messageId: "message-1",
            text: "only run one",
          });

          yield* Deferred.succeed(firstRelease, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(collectedFirst.fiber);
          yield* Fiber.join(collectedSecond.fiber);

          return {
            first: Array.from(yield* Queue.takeAll(collectedFirst.queue)),
            second: Array.from(yield* Queue.takeAll(collectedSecond.queue)),
          };
        }).pipe(Effect.provide(liveRunsLayer)),
      ),
    );

    expect(eventTypes(result.first)).toContain("run.steered");
    expect(eventTypes(result.second)).not.toContain("run.steered");
    expect(result.first[0]).toMatchObject({ runId: "run-1", seq: 1 });
    expect(result.second[0]).toMatchObject({ runId: "run-2", seq: 1 });
  });

  it("replays the same script as the same event sequence every run", async () => {
    const script: readonly EmulatorStep[] = [
      { kind: "token.delta", messageId: "assistant-1", delta: "thinking" },
      {
        kind: "tool.immediate",
        callId: "call-1",
        tool: "lookup",
        arguments: {},
        result: { ok: true },
      },
      { kind: "await.steer" },
      { kind: "run.completed", messageId: "assistant-1" },
    ];
    const send = (liveRuns: LiveRunsShape) =>
      liveRuns.dispatch("run-1", { type: "steer", messageId: "message-1", text: "carry on" });

    const first = await Effect.runPromise(
      driveRun("run-1", script, send).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );
    const second = await Effect.runPromise(
      driveRun("run-1", script, send).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    expect(second).toEqual(first);
  });

  it("fails the event stream when a script runs off its end instead of completing", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { session } = yield* AgentRuntime;
          return yield* Effect.exit(Stream.runCollect(session.events));
        }).pipe(
          Effect.provide(
            emulatorAgentRuntimeLayer(startRequest("run-1"), [
              { kind: "token.delta", messageId: "assistant-1", delta: "half a thought" },
            ]),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defect = Cause.dieOption(exit.cause);
      expect(Option.isSome(defect)).toBe(true);
      if (Option.isSome(defect)) {
        expect(defect.value).toBeInstanceOf(EmulatorScriptError);
      }
    }
  });

  it("refuses to bless a run runtime layer as a process singleton", () => {
    const layer = emulatorAgentRuntimeLayer(startRequest("run-1"), []);

    expect(() => {
      // @ts-expect-error a run runtime layer is request-scoped: blessing it as a
      // singleton would bake one run's session into the boot path.
      processSingleton(layer);
    }).not.toThrow();
  });
});

describe("the offline runtime executing tools", () => {
  function memoryLedger(): ToolCallLedger {
    const settled = new Map<string, ToolOutcome>();

    return {
      begin: async (call): Promise<ToolCallAdmission> =>
        settled.get(call.callId) ?? { status: "started" },
      complete: async (call, result): Promise<ToolOutcome> => {
        const outcome: ToolOutcome = { status: "completed", result };
        settled.set(call.callId, outcome);
        return outcome;
      },
      fail: async (call, error): Promise<ToolOutcome> => {
        const outcome: ToolOutcome = { status: "failed", error };
        settled.set(call.callId, outcome);
        return outcome;
      },
    };
  }

  function dispatcherWith(registration: {
    readonly name: string;
    readonly execute: (call: ToolCall) => Effect.Effect<unknown, unknown>;
  }) {
    return createToolDispatcher({
      registrations: [
        {
          name: registration.name,
          description: "A tool the scripted run may call.",
          parameters: { type: "object" },
          maxDurationMs: 1_000,
          execute: registration.execute,
        },
      ],
      ledger: memoryLedger(),
      leaseTtlMs: 120_000,
      heartbeat: Effect.void,
    });
  }

  function run(
    script: readonly EmulatorStep[],
    tools: ReturnType<typeof dispatcherWith>,
    send?: (liveRuns: LiveRunsShape) => Effect.Effect<void, RunGoneError>,
  ) {
    return Effect.runPromise(
      driveRun("run-1", script, send, { tools }).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );
  }

  it("executes a tool step and emits the machine's real result", async () => {
    const executed: ToolCall[] = [];
    const dispatcher = dispatcherWith({
      name: "lookup",
      execute: (call) =>
        Effect.sync(() => {
          executed.push(call);
          return { value: 42 };
        }),
    });

    const events = await run(
      [
        { kind: "tool.immediate", callId: "call-1", tool: "lookup", arguments: { query: "x" } },
        { kind: "run.completed" },
      ],
      dispatcher,
    );

    expect(eventTypes(events)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "run.completed",
    ]);
    expect(events[2]).toMatchObject({ callId: "call-1", result: { value: 42 } });
    expect(executed).toEqual([
      { runId: "run-1", callId: "call-1", tool: "lookup", arguments: { query: "x" } },
    ]);
  });

  it("executes an approved call and reports the handler's failure as tool.failed", async () => {
    const executed: string[] = [];
    const dispatcher = dispatcherWith({
      name: "lookup",
      execute: (call) =>
        Effect.sync(() => {
          executed.push(call.callId);
          return { delivered: true };
        }),
    });

    const events = await run(
      [
        {
          kind: "tool.awaiting_approval",
          callId: "call-approved",
          tool: "lookup",
          arguments: {},
        },
        { kind: "run.completed" },
      ],
      dispatcher,
      (liveRuns) => liveRuns.dispatch("run-1", { type: "approve", callId: "call-approved" }),
    );

    expect(eventTypes(events)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "run.completed",
    ]);
    expect(executed).toEqual(["call-approved"]);
  });

  it("reports a handler that broke as the call's failure, not the run's", async () => {
    const dispatcher = dispatcherWith({
      name: "lookup",
      execute: () => Effect.fail(new Error("the machine broke")),
    });

    const events = await run(
      [
        { kind: "tool.immediate", callId: "call-1", tool: "lookup", arguments: {} },
        { kind: "run.completed" },
      ],
      dispatcher,
    );

    expect(eventTypes(events)).toEqual([
      "run.started",
      "tool.requested",
      "tool.failed",
      "run.completed",
    ]);
    expect(events[2]).toMatchObject({ callId: "call-1", error: 'tool "lookup" failed' });
  });

  it("stops a call in flight promptly and commits nothing it was doing", async () => {
    let interrupted = false;
    const dispatcher = dispatcherWith({
      name: "lookup",
      execute: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
    });

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Deferred.make<RunSession>();

          const runFiber = yield* Effect.fork(
            withLiveRun(
              "run-1",
              emulatorAgentRuntimeLayer(
                startRequest("run-1"),
                [
                  { kind: "tool.immediate", callId: "call-1", tool: "lookup", arguments: {} },
                  { kind: "run.completed" },
                ],
                { tools: dispatcher },
              ),
              (live) => Deferred.succeed(session, live).pipe(Effect.zipRight(Effect.never)),
            ),
          );

          const live = yield* Deferred.await(session);
          const { queue, fiber: collector } = yield* collectEvents(live);

          const events: RunEvent[] = [];
          while (!events.some((event) => event.type === "tool.requested")) {
            events.push(yield* Queue.take(queue));
          }

          const liveRuns = yield* LiveRuns;
          yield* liveRuns.dispatch("run-1", {
            type: "stop",
            reason: "the operator stopped this run",
          });

          yield* Fiber.join(collector);
          events.push(...Array.from(yield* Queue.takeAll(queue)));
          yield* Fiber.interrupt(runFiber);

          return events;
        }).pipe(Effect.provide(liveRunsLayer)),
      ),
    );

    expect(eventTypes(observed)).toEqual(["run.started", "tool.requested", "run.cancelled"]);
    expect(observed.at(-1)).toMatchObject({ reason: "the operator stopped this run" });
    expect(interrupted).toBe(true);
  });

  it("turns an unregistered tool into a failed call the model can recover from", async () => {
    const dispatcher = dispatcherWith({ name: "lookup", execute: () => Effect.succeed(null) });

    const events = await run(
      [
        { kind: "tool.immediate", callId: "call-1", tool: "missing", arguments: {} },
        { kind: "run.completed" },
      ],
      dispatcher,
    );

    expect(eventTypes(events)).toEqual([
      "run.started",
      "tool.requested",
      "tool.failed",
      "run.completed",
    ]);
    expect(events[2]).toMatchObject({
      error: 'the tool "missing" is not registered for this run',
    });
  });

  it("reports a scripted turn's usage through the supplied recorder", async () => {
    const usage: RunUsage[] = [];
    const recorder: UsageRecorder = {
      record: async (record) => {
        usage.push(record);
      },
    };

    const events = await Effect.runPromise(
      driveRun(
        "run-usage",
        [
          {
            kind: "usage",
            provider: "openai",
            model: "test-model",
            inputTokens: 1200,
            outputTokens: 340,
          },
          { kind: "run.completed" },
        ],
        undefined,
        { usage: recorder },
      ).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    expect(usage).toEqual([
      {
        runId: "run-usage",
        provider: "openai",
        model: "test-model",
        inputTokens: 1200,
        outputTokens: 340,
      },
    ]);
    expect(eventTypes(events)).toEqual(["run.started", "run.completed"]);
  });

  it("records an omitted field as not reported, never a zero", async () => {
    const usage: RunUsage[] = [];
    const recorder: UsageRecorder = {
      record: async (record) => {
        usage.push(record);
      },
    };

    await Effect.runPromise(
      driveRun("run-usage", [{ kind: "usage" }, { kind: "run.completed" }], undefined, {
        usage: recorder,
      }).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    expect(usage).toEqual([
      { runId: "run-usage", provider: null, model: null, inputTokens: null, outputTokens: null },
    ]);
  });

  it("keeps running when the recorder refuses a write", async () => {
    const recorder: UsageRecorder = {
      record: async () => {
        throw new Error("the ledger is down");
      },
    };

    const events = await Effect.runPromise(
      driveRun(
        "run-usage",
        [
          { kind: "usage", inputTokens: 1, outputTokens: 1 },
          { kind: "run.failed", error: "the model failed after one turn" },
        ],
        undefined,
        { usage: recorder },
      ).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    // The failed run still reports its one turn's record attempt and its own
    // terminal event; the usage write is never allowed to change the outcome.
    expect(eventTypes(events)).toEqual(["run.started", "run.failed"]);
  });

  it("refuses a tool step with no result when the runtime holds no dispatcher", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { session } = yield* AgentRuntime;
          return yield* Effect.exit(Stream.runCollect(session.events));
        }).pipe(
          Effect.provide(
            emulatorAgentRuntimeLayer(startRequest("run-1"), [
              { kind: "tool.immediate", callId: "call-1", tool: "lookup", arguments: {} },
            ]),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defect = Cause.dieOption(exit.cause);
      expect(Option.isSome(defect)).toBe(true);
      if (Option.isSome(defect)) {
        expect(defect.value).toBeInstanceOf(EmulatorScriptError);
      }
    }
  });
});
