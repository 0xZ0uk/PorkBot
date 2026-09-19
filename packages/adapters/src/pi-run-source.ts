import { Cause, Effect, Layer, Mailbox, Ref, Stream } from "effect";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { AgentRuntime, requestScoped } from "@porkbot/effect";
import type { AgentRuntimeLayer, RunCommand, RunSession, RunStartRequest } from "@porkbot/effect";
import { PiRunTranslator } from "./pi-events.ts";

/**
 * The Pi runtime adapted to the duplex `RunSession` seam (slice 5.3, PRD
 * decision 13: "Pi's async iterators are adapted at this boundary and nowhere
 * else").
 *
 * Pi hands back an async iterator of canonical events and a live run it lets
 * you steer, abort and gate. `piAgentRuntimeLayer` is the seam that consumes
 * that iterator and exposes exactly the package's `AgentRuntimeLayer`: the
 * `RunEvent` stream a client reduces, and the `RunCommand` mailbox an operator
 * writes into. No Pi type appears in what the function returns, so the
 * orchestrator swaps this adapter for the offline emulator by changing the
 * layer it provides and nothing else.
 *
 * The session owns neither the run's durability nor its model wiring. It turns
 * events into the wire vocabulary with `PiRunTranslator`, forwards commands to
 * the `PiRunControls` the launch supplies, and reports cancellation as the
 * terminal `run.cancelled` when interruption closes its scope — which is how
 * losing the fence stops the run fiber tree (PRD decision 26).
 *
 * The live launch that builds a `PiRunSource` from a real Pi `Agent` belongs
 * with the run executor that also assembles the model runtime; this module is
 * deliberately the seam, and `recordedPiRunSource` is the offline source the
 * golden corpus replays.
 */

/** One operator decision on a tool call awaiting approval. */
export type PiApprovalDecision =
  { readonly kind: "approve" } | { readonly kind: "deny"; readonly reason?: string };

/**
 * The write half of a live Pi run: the operations a `RunCommand` becomes.
 * Steering injects an operator message mid-run, stopping aborts it, and a
 * decision resolves the approval gate for one tool call.
 */
export interface PiRunControls {
  steer(text: string): void | Promise<void>;
  stop(reason?: string): void | Promise<void>;
  decide(callId: string, decision: PiApprovalDecision): void | Promise<void>;
}

/**
 * A live Pi run as the adapter sees it: an async iterator of canonical events
 * plus the controls that write into it. This is the only Pi-shaped thing that
 * crosses into this module, and everything else is Effect and `RunEvent`.
 */
export interface PiRunSource {
  readonly events: AsyncIterable<unknown>;
  readonly controls: PiRunControls;
}

/** Base class for every failure this adapter raises while adapting a run. */
export class PiRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiRunError";
  }
}

/** The Pi event iterator itself failed; `sourceCause` is the thrown value. */
export class PiRunSourceError extends PiRunError {
  readonly sourceCause: unknown;

  constructor(message: string, sourceCause: unknown) {
    super(message);
    this.name = "PiRunSourceError";
    this.sourceCause = sourceCause;
  }
}

/** The Pi source ended without ever producing a terminal event. */
export class PiRunSourceEnded extends PiRunError {
  constructor(message: string) {
    super(message);
    this.name = "PiRunSourceEnded";
  }
}

/** A control operation (steer, stop, decide) threw while the run was live. */
export class PiRunControlError extends PiRunError {
  readonly controlCause: unknown;

  constructor(message: string, controlCause: unknown) {
    super(message);
    this.name = "PiRunControlError";
    this.controlCause = controlCause;
  }
}

/**
 * Adapts one Pi run to the shipped `AgentRuntimeLayer`: events out, commands
 * in, cancellation through interruption. Build it inside the run's scope.
 */
export function piAgentRuntimeLayer(
  request: RunStartRequest,
  source: PiRunSource,
): AgentRuntimeLayer {
  const acquire = Effect.gen(function* () {
    const events = yield* Mailbox.make<RunEvent, unknown>();
    const commands = yield* Mailbox.make<RunCommand>();
    const translator = new PiRunTranslator({
      threadId: request.threadId,
      runId: request.runId,
      startSeq: request.startSeq,
    });
    const finished = yield* Ref.make(false);

    const frame = (seq: number) =>
      ({
        schemaVersion: RUN_EVENT_SCHEMA_VERSION,
        seq,
        threadId: request.threadId,
        runId: request.runId,
      }) as const;

    const iterator = source.events[Symbol.asyncIterator]();
    const closeSource = () => {
      void iterator.return?.(undefined);
    };

    /**
     * Ends the session exactly once: the mailboxes close, the source is
     * released, and a later terminal or cancellation is a no-op rather than a
     * second terminal event.
     */
    const finish = Effect.gen(function* () {
      const already = yield* Ref.getAndSet(finished, true);

      if (already) {
        return false;
      }

      closeSource();
      yield* events.end;
      yield* commands.end;
      return true;
    });

    const cancel = (reason: string) =>
      Effect.gen(function* () {
        const already = yield* Ref.getAndSet(finished, true);

        if (already) {
          return;
        }

        closeSource();
        const seq = translator.allocateSeq();
        yield* events.offer({ ...frame(seq), type: "run.cancelled", reason });
        yield* events.end;
        yield* commands.end;
      });

    const invokeControl = (label: string, run: () => void | Promise<void>) =>
      Effect.tryPromise({
        try: async () => {
          await run();
        },
        catch: (controlCause) =>
          new PiRunControlError(`Pi ${label} failed while adapting a run`, controlCause),
      }).pipe(Effect.orDie);

    const handleCause = (cause: Cause.Cause<unknown>) => {
      if (Cause.isInterrupted(cause)) {
        return Effect.interrupt;
      }

      return Effect.gen(function* () {
        const already = yield* Ref.getAndSet(finished, true);

        if (already) {
          return;
        }

        yield* events.failCause(cause);
        yield* commands.end;
      });
    };

    /**
     * The event half: pull one Pi event at a time, translate it with the
     * mapping table, and offer the resulting `RunEvent`s in order. An
     * untranslatable event is a defect — the stream has no error channel by
     * design, so a malformed frame must not be mistaken for a quiet gap.
     */
    const pump = Effect.gen(function* () {
      for (;;) {
        if (yield* Ref.get(finished)) {
          return;
        }

        const step = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (sourceCause) =>
            new PiRunSourceError("the Pi event source threw while adapting a run", sourceCause),
        }).pipe(Effect.orDie);

        if (step.done === true) {
          if (!(yield* Ref.get(finished))) {
            yield* Effect.die(
              new PiRunSourceEnded("the Pi event source ended without a terminal event"),
            );
          }

          return;
        }

        const result = translator.translate(step.value);

        if (!result.ok) {
          yield* Effect.die(result.error);
          return;
        }

        for (const event of result.events) {
          yield* events.offer(event);
        }

        if (result.terminal) {
          yield* finish;
          return;
        }
      }
    }).pipe(
      Effect.onInterrupt(() => cancel("interrupted")),
      Effect.catchAllCause(handleCause),
    );

    /**
     * The command half: an operator write reaches the live run and is
     * acknowledged as the event it causes. A steer is answered immediately with
     * `run.steered`; a stop cancels and reports the operator's reason; approve
     * and deny resolve the matching gate. A command for a finished run finds an
     * ended mailbox and stops quietly — `LiveRuns` has already answered the
     * caller, and a stale write must never resurrect a terminal run.
     */
    const commandLoop = Effect.gen(function* () {
      for (;;) {
        const command = yield* commands.take;

        if (yield* Ref.get(finished)) {
          return;
        }

        switch (command.type) {
          case "stop": {
            yield* invokeControl("stop", () => source.controls.stop(command.reason));
            yield* cancel(command.reason ?? "stop");
            return;
          }
          case "steer": {
            yield* invokeControl("steer", () => source.controls.steer(command.text));
            const seq = translator.allocateSeq();
            yield* events.offer({
              ...frame(seq),
              type: "run.steered",
              messageId: command.messageId,
              text: command.text,
            });
            break;
          }
          case "approve": {
            yield* invokeControl("approval", () =>
              source.controls.decide(command.callId, { kind: "approve" }),
            );
            break;
          }
          case "deny": {
            yield* invokeControl("approval", () =>
              source.controls.decide(command.callId, {
                kind: "deny",
                ...(command.reason === undefined ? {} : { reason: command.reason }),
              }),
            );
            break;
          }
        }
      }
    }).pipe(Effect.catchAllCause(handleCause));

    yield* Effect.forkScoped(pump);
    yield* Effect.forkScoped(commandLoop);

    return {
      session: {
        events: Mailbox.toStream(events).pipe(Stream.orDie),
        commands,
      } satisfies RunSession,
    };
  });

  return requestScoped(Layer.scoped(AgentRuntime, acquire));
}

/**
 * The offline source the golden corpus replays: a fixed list of recorded Pi
 * events and controls that do nothing. It exists so a recorded real session
 * can drive the shipped adapter with no network, no keys and no clock.
 */
export function recordedPiRunSource(events: readonly unknown[]): PiRunSource {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
    },
    controls: {
      steer: () => undefined,
      stop: () => undefined,
      decide: () => undefined,
    },
  };
}
