import { Effect, Ref, Stream } from "effect";
import type { RunEvent } from "@porkbot/core";
import type { RunSession } from "./agent-runtime.ts";

/**
 * The cross-process half of a live run's command mailbox (slice 6.7, stories
 * 20 and 21).
 *
 * A `RunSession`'s commands mailbox is process-local: the API process that
 * receives a steer or a stop cannot reach the worker process that is executing
 * the run. The channel between them is durable, so both commands are rows
 * first and mailbox entries second:
 *
 *   - A steer is the `steering_message` row the send wrote, bound to the run
 *     it addressed. `claimSteers` hands each unclaimed row to exactly one
 *     claimant, oldest first, so a run that already finished leaves its steers
 *     unclaimed instead of replaying them into the next run.
 *   - A stop is the `stop_requested_at` mark on the run row. It is a request,
 *     not an effect: the live run observes it and cancels itself, which is
 *     what lets the cancellation carry the session's own event sequence and
 *     the executor release the lease through the ordinary fenced write.
 *
 * `pumpRunCommands` is the read half: it polls the source and offers the
 * commands it finds into the session's mailbox, and it ends when the mailbox
 * does. Polling is the same latency knob the approval gate uses, not a
 * correctness one — every command is durable already, so a lost tick loses
 * nothing but time.
 *
 * `consumeRunSession` is the event half: it drains the session once, hands
 * every event to the caller (the recorder, the sink, the fanout) and reports
 * the terminal outcome. A session that ends in `run.cancelled` is a run the
 * operator stopped, and the worker's executor settles it `cancelled` rather
 * than `completed` because of this outcome — the same cancellation the stream
 * already shows.
 */

/**
 * How long between source reads. It is a latency bound on how long a steer or
 * a stop takes to reach a live run, not a correctness one.
 */
export const RUN_COMMAND_POLL_INTERVAL_MS = 250;

/** One claimed steering command: the row's text and the message it belongs to. */
export interface PendingSteer {
  readonly messageId: string;
  readonly text: string;
}

/**
 * The durable commands a live run can claim, implemented by `@porkbot/db`
 * over the steering rows and the run row. Both reads are scoped to the run,
 * so a foreign run is an empty answer rather than a write.
 */
export interface RunCommandSource {
  /**
   * Claims every unclaimed steer bound to the run, oldest first. Each row is
   * claimed by exactly one caller; a second concurrent claim gets nothing.
   */
  claimSteers(runId: string): Promise<readonly PendingSteer[]>;
  /**
   * Whether the run's operator has asked it to stop. It never clears: a
   * resumed run that finds the mark cancels immediately, exactly as the
   * original would have.
   */
  stopRequested(runId: string): Promise<boolean>;
}

export interface RunCommandPumpOptions {
  readonly runId: string;
  readonly source: RunCommandSource;
  /** Defaults to `RUN_COMMAND_POLL_INTERVAL_MS`. */
  readonly pollIntervalMs?: number;
}

/** The reason a stop offered by the pump carries when the operator gave none. */
export const DEFAULT_STOP_REASON = "the operator stopped this run";

/**
 * Forwards one run's durable commands into its live session until the session
 * ends. Run it beside `consumeRunSession`; a command offered after the session
 * closed is refused by the mailbox and ends the pump rather than resurrecting
 * a terminal run.
 */
export function pumpRunCommands(
  session: RunSession,
  options: RunCommandPumpOptions,
): Effect.Effect<void> {
  const interval = options.pollIntervalMs ?? RUN_COMMAND_POLL_INTERVAL_MS;

  const tick = Effect.gen(function* () {
    const steers = yield* poll(
      () => options.source.claimSteers(options.runId),
      [] as readonly PendingSteer[],
    );

    for (const steer of steers) {
      const accepted = yield* session.commands.offer({
        type: "steer",
        messageId: steer.messageId,
        text: steer.text,
      });

      if (!accepted) {
        return false;
      }
    }

    if (yield* poll(() => options.source.stopRequested(options.runId), false)) {
      yield* session.commands.offer({ type: "stop", reason: DEFAULT_STOP_REASON });
      return false;
    }

    return true;
  });

  const loop = Effect.gen(function* () {
    while (yield* tick) {
      yield* Effect.sleep(interval);
    }
  });

  // The mailbox's own end is the pump's stop signal: a session that finished
  // (completed or cancelled) ends its mailbox, and polling it further would
  // only wait for a run that no longer exists. Whichever half finishes first
  // interrupts the other through the race.
  return Effect.raceFirst(loop, session.commands.await);
}

/**
 * One source read, with a failure treated as "nothing this tick". A database
 * the pump cannot read must not fail a live run — the run's own lease
 * heartbeat is what fails it when its storage is gone — so the read is retried
 * on the next tick and the run keeps working in the meantime.
 */
function poll<A>(read: () => Promise<A>, empty: A): Effect.Effect<A> {
  return Effect.tryPromise({ try: read, catch: () => undefined }).pipe(
    Effect.catchAll(() => Effect.succeed(empty)),
  );
}

/**
 * How a session ended. The run's executor settles the row from this outcome:
 * `completed` closes it normally, `cancelled` settles it `cancelled` and
 * releases its lease, and a terminal `run.failed` event settles it failed
 * with the event's own error rather than reading as a success.
 */
export type RunSessionOutcome =
  | { readonly status: "completed" }
  | { readonly status: "cancelled"; readonly reason?: string }
  | { readonly status: "failed"; readonly error: string; readonly code?: string };

/**
 * Drains one session's events once, handing every event to `onEvent` (the
 * recorder, the durable sink, the fanout) and returning the terminal outcome.
 * A session whose stream ends without a terminal event is a defect: every
 * runtime's contract is exactly one terminal event, and reporting a silent
 * completion would settle a run nobody finished.
 */
export function consumeRunSession<E = never, R = never>(
  session: RunSession,
  onEvent: (event: RunEvent) => Effect.Effect<void, E, R>,
): Effect.Effect<RunSessionOutcome, E, R> {
  return Effect.gen(function* () {
    const terminal = yield* Ref.make<RunSessionOutcome | undefined>(undefined);

    yield* session.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          yield* onEvent(event);

          const outcome = terminalOutcome(event);

          if (outcome !== undefined) {
            const already = yield* Ref.getAndSet(terminal, outcome);

            // The seam's contract is exactly one terminal event. A second one
            // is a runtime defect, and swallowing it would settle the run from
            // whichever event happened to arrive last.
            if (already !== undefined) {
              return yield* Effect.die(
                new Error("the run session emitted more than one terminal event"),
              );
            }
          }
        }),
      ),
    );

    const settled = yield* Ref.get(terminal);

    if (settled === undefined) {
      return yield* Effect.die(new Error("the run session ended without a terminal event"));
    }

    return settled;
  });
}

function terminalOutcome(event: RunEvent): RunSessionOutcome | undefined {
  switch (event.type) {
    case "run.completed":
      return { status: "completed" };
    case "run.cancelled":
      return {
        status: "cancelled",
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
    case "run.failed":
      return {
        status: "failed",
        error: event.error,
        ...(event.code === undefined ? {} : { code: event.code }),
      };
    default:
      return undefined;
  }
}
