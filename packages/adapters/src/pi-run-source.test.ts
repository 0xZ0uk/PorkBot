import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { parseRunEvent } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import {
  AgentRuntime,
  LiveRuns,
  liveRunsLayer,
  processSingleton,
  withLiveRun,
} from "@porkbot/effect";
import type { AgentRuntimeLayer, RunCommand, RunGoneError, RunStartRequest } from "@porkbot/effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { piAgentRuntimeLayer, PiRunSourceEnded, recordedPiRunSource } from "./pi-run-source.ts";
import type { PiApprovalDecision, PiRunSource } from "./pi-run-source.ts";
import { UnknownPiEventType } from "./pi-events.ts";

/**
 * The Pi adapter's half of the duplex seam (slice 5.3, PRD decision 13). Pi's
 * async iterator is the input, `RunSession` is the output, and the commands
 * mailbox is the operator's write into the live run: every test here drives the
 * shipped `piAgentRuntimeLayer` and asserts `RunEvent`s, never Pi internals.
 */

function startRequest(): RunStartRequest {
  return {
    runId: "run-pi",
    threadId: "thread-pi",
    startSeq: 1,
    connection: { baseUrl: "https://model.example.test/v1", credentialName: "pi-key" },
    model: "corpus-model",
    messages: [{ role: "user", content: "hello" }],
  };
}

interface RecordedControls {
  readonly steers: string[];
  readonly stops: (string | undefined)[];
  readonly decisions: { readonly callId: string; readonly decision: PiApprovalDecision }[];
}

interface ControlledSource {
  readonly source: PiRunSource;
  readonly calls: RecordedControls;
  push(event: unknown): void;
  end(): void;
}

/**
 * A live Pi run the test drives: events are pushed by the test, the iterator
 * blocks until the next push, and controls record what the adapter wrote.
 */
function controlledSource(initial: readonly unknown[] = []): ControlledSource {
  const pending = [...initial];
  let wake: (() => void) | undefined;
  let closed = false;
  const calls: RecordedControls = { steers: [], stops: [], decisions: [] };

  const source: PiRunSource = {
    events: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (pending.length > 0) {
            yield pending.shift();
          }

          if (closed) {
            return;
          }

          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    controls: {
      steer: (text) => {
        calls.steers.push(text);
      },
      stop: (reason) => {
        calls.stops.push(reason);
      },
      decide: (callId, decision) => {
        calls.decisions.push({ callId, decision });
      },
    },
  };

  return {
    source,
    calls,
    push(event) {
      pending.push(event);
      wake?.();
      wake = undefined;
    },
    end() {
      closed = true;
      wake?.();
      wake = undefined;
    },
  };
}

function runWithCommand(
  command: RunCommand,
  controlled: ControlledSource,
): Effect.Effect<Option.Option<RunEvent>, RunGoneError> {
  return Effect.gen(function* () {
    const liveRuns = yield* LiveRuns;

    return yield* withLiveRun(
      "run-pi",
      piAgentRuntimeLayer(startRequest(), controlled.source),
      (live) =>
        Effect.gen(function* () {
          const head = yield* Effect.fork(Stream.runHead(live.events));
          yield* liveRuns.dispatch("run-pi", command);
          return yield* Fiber.join(head);
        }),
    );
  }).pipe(Effect.provide(liveRunsLayer));
}

async function collectExit(events: readonly unknown[]) {
  const program = Effect.gen(function* () {
    const { session } = yield* AgentRuntime;
    return yield* Effect.exit(Stream.runCollect(session.events));
  }).pipe(Effect.provide(piAgentRuntimeLayer(startRequest(), recordedPiRunSource(events))));

  return Effect.runPromise(Effect.scoped(program));
}

describe("the Pi runtime seam", () => {
  it("returns the shipped run layer and names no Pi type in doing so", () => {
    expectTypeOf(piAgentRuntimeLayer).returns.toEqualTypeOf<AgentRuntimeLayer>();
    expectTypeOf<PiRunSource["events"]>().toEqualTypeOf<AsyncIterable<unknown>>();
  });

  it("reports a steer as run.steered and writes it into the live run", async () => {
    const controlled = controlledSource();
    const first = await Effect.runPromise(
      runWithCommand({ type: "steer", text: "be brief" }, controlled),
    );

    expect(Option.isSome(first)).toBe(true);
    if (Option.isSome(first)) {
      expect(first.value).toMatchObject({ type: "run.steered", text: "be brief" });
      expect(parseRunEvent(first.value).ok).toBe(true);
    }
    expect(controlled.calls.steers).toEqual(["be brief"]);
  });

  it("stops the run and reports the operator's reason as run.cancelled", async () => {
    const controlled = controlledSource();
    const first = await Effect.runPromise(
      runWithCommand({ type: "stop", reason: "operator stopped it" }, controlled),
    );

    expect(Option.isSome(first)).toBe(true);
    if (Option.isSome(first)) {
      expect(first.value).toMatchObject({ type: "run.cancelled", reason: "operator stopped it" });
    }
    expect(controlled.calls.stops).toEqual(["operator stopped it"]);
  });

  it("forwards approve and deny decisions to the matching tool call", async () => {
    const approve = controlledSource();
    const deny = controlledSource();

    await Effect.runPromise(
      Effect.gen(function* () {
        const liveRuns = yield* LiveRuns;
        yield* withLiveRun("run-pi", piAgentRuntimeLayer(startRequest(), approve.source), () =>
          liveRuns
            .dispatch("run-pi", { type: "approve", callId: "call-1" })
            .pipe(Effect.zipRight(Effect.sleep("20 millis"))),
        );
        yield* withLiveRun("run-pi", piAgentRuntimeLayer(startRequest(), deny.source), () =>
          liveRuns
            .dispatch("run-pi", { type: "deny", callId: "call-2", reason: "not this" })
            .pipe(Effect.zipRight(Effect.sleep("20 millis"))),
        );
      }).pipe(Effect.provide(liveRunsLayer)),
    );

    expect(approve.calls.decisions).toEqual([{ callId: "call-1", decision: { kind: "approve" } }]);
    expect(deny.calls.decisions).toEqual([
      { callId: "call-2", decision: { kind: "deny", reason: "not this" } },
    ]);
  });

  it("fails the event stream typed when a Pi event is unknown", async () => {
    const exit = await collectExit([{ type: "agent_paused" }]);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defect = Cause.dieOption(exit.cause);
      expect(Option.isSome(defect)).toBe(true);
      if (Option.isSome(defect)) {
        expect(defect.value).toBeInstanceOf(UnknownPiEventType);
      }
    }
  });

  it("fails the event stream when the source ends without a terminal event", async () => {
    const exit = await collectExit([{ type: "agent_start" }]);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defect = Cause.dieOption(exit.cause);
      expect(Option.isSome(defect)).toBe(true);
      if (Option.isSome(defect)) {
        expect(defect.value).toBeInstanceOf(PiRunSourceEnded);
      }
    }
  });

  it("refuses to bless a Pi run layer as a process singleton", () => {
    const layer = piAgentRuntimeLayer(startRequest(), controlledSource().source);

    expect(() => {
      // @ts-expect-error a run runtime layer is request-scoped: blessing it as a
      // singleton would bake one run's session into the boot path.
      processSingleton(layer);
    }).not.toThrow();
  });
});
