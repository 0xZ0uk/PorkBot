import { Cause, Deferred, Effect, Exit, Option, Schedule } from "effect";
import type { Duration } from "effect";
import { LeaseLostError } from "./errors.ts";
import { fenced } from "./agent-runtime.ts";

/**
 * The run's fenced lifetime, as one combinator (slice 6.3, PRD decisions 1, 25
 * and 26).
 *
 * A worker that holds a run owns two obligations that must not be separable:
 * it must renew the lease while it works, and it must stop working the instant
 * the renewal stops being its own. `withRunFence` is both. It beats once
 * immediately and then on the caller's interval, and any beat that cannot be
 * renewed — a typed `LeaseLostError`, or any other failure at all — completes a
 * `fenceLost` deferred, which races the run and interrupts its whole fiber tree.
 * An adapter inside the run therefore cancels and reports; it never completes a
 * tool call and commits a side effect the next owner has already been promised.
 *
 * Failing closed is deliberate: a worker that cannot prove it still owns the
 * lease is in exactly the position of one that lost it, so a database error
 * during a beat interrupts the run too. The alternative — retrying quietly
 * while the lease runs out under the run — is the case the fence exists to make
 * impossible.
 *
 * The heartbeat fiber lives in the combinator's own scope, so a run that
 * finishes first stops being renewed the moment it is done, and a run that is
 * interrupted has nothing left beating behind it. The caller supplies the beat
 * as an Effect — normally a scoped repository write — so this module stays free
 * of any data layer.
 */

export interface RunFenceOptions {
  readonly runId: string;
  /**
   * One lease renewal. A `LeaseLostError` means the fence moved to another
   * owner; any other failure is treated the same way, because work that cannot
   * be renewed cannot be committed.
   */
  readonly heartbeat: Effect.Effect<void, LeaseLostError>;
  /** How long to wait between beats. The first beat runs immediately. */
  readonly interval: Duration.DurationInput;
}

/**
 * Runs one run's work under its lease: beats until the work ends or the fence
 * is lost, and interrupts the work in the second case.
 *
 * The returned effect's failure channel is the work's own plus
 * `LeaseLostError`, so a caller can tell "the run failed" from "this process
 * stopped owning the run" without inspecting a cause.
 */
export function withRunFence<A, E, R>(
  options: RunFenceOptions,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LeaseLostError, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const fenceLost = yield* Deferred.make<LeaseLostError>();

      yield* Effect.forkScoped(
        options.heartbeat.pipe(
          Effect.repeat(Schedule.spaced(options.interval)),
          // Fail closed on any way the beat loop ends except the scope's own
          // interruption: a typed loss completes the deferred with its error, a
          // defect completes it with a lease loss of the same run, and nothing
          // reaches the run as a raw cause.
          Effect.onExit((exit) => {
            if (!Exit.isFailure(exit) || Cause.isInterrupted(exit.cause)) {
              return Effect.void;
            }

            const failure = Cause.failureOption(exit.cause);

            return Deferred.succeed(
              fenceLost,
              Option.isSome(failure) ? failure.value : new LeaseLostError(options.runId),
            );
          }),
        ),
      );

      return yield* fenced(fenceLost, run);
    }),
  );
}
