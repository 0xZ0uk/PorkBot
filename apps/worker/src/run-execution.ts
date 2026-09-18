import { Cause, Effect, Exit, Option } from "effect";
import { RUN_HEARTBEAT_INTERVAL_SECONDS } from "@porkbot/db";
import type { FencedRunPatch, RunRecord, SystemRepositories } from "@porkbot/db";
import { LeaseLostError, withRunFence } from "@porkbot/effect";
import type { RunExecution, RunExecutor } from "./jobs/run-execute.ts";

/**
 * The worker's execution harness (slice 6.3, PRD decisions 25 and 26).
 *
 * This is the frame every run executes inside. It owns the four things the
 * correctness story needs and the run's work must not each remember:
 *
 *   - the fence: `withRunFence` renews the lease on the shared interval and, on
 *     the first beat that cannot be renewed, interrupts the whole fiber tree —
 *     the runtime loop, the in-flight tool call, everything — before any of it
 *     can complete and commit;
 *   - the outcome: work that finishes settles the run `completed` and the
 *     attempt with it, in one fenced statement;
 *   - the failure: work that throws settles the run `failed` with its attempt,
 *     so a failed run never reads as running;
 *   - the loss: a run whose fence moved is not written to at all. Its attempt
 *     is closed as `abandoned` on a best-effort basis, because the winner's
 *     reclaim may already have done it, and the run belongs to the winner.
 *
 * The work itself is a seam: 6.9 supplies the model and computer tools here,
 * and the harness does not change when it does. It receives the `RunExecution`
 * the job handler acquired — including whether this is a resume — and must
 * build its session from the run's checkpoint when it is.
 */

/** A run's work. The harness classifies its failure; it never reaches a client. */
export type RunWork = (execution: RunExecution) => Effect.Effect<void, unknown>;

export interface RunExecutionOptions {
  readonly work: RunWork;
  /**
   * How long between lease renewals. Defaults to the shared heartbeat
   * interval; tests shorten it so a lost lease interrupts promptly.
   */
  readonly heartbeatIntervalMs?: number;
}

export function createRunExecutor(options: RunExecutionOptions): RunExecutor {
  const interval = options.heartbeatIntervalMs ?? RUN_HEARTBEAT_INTERVAL_SECONDS * 1000;

  return async (execution) => {
    const { run, repositories, logger } = execution;
    const lease = { owner: requiredOwner(run), fence: run.leaseFence };

    const program = Effect.gen(function* () {
      const outcome = yield* options.work(execution).pipe(Effect.exit);

      if (Exit.isSuccess(outcome)) {
        yield* settle(repositories, run, lease, {
          status: "completed",
          completed: true,
          attempt: "completed",
        });
        return;
      }

      // An interrupt or a lost-lease failure means this process no longer owns
      // the run: it must not write a terminal state another owner may hold.
      if (
        Cause.isInterrupted(outcome.cause) ||
        firstFailure(outcome.cause) instanceof LeaseLostError
      ) {
        return yield* Effect.fail(new LeaseLostError(run.id));
      }

      yield* settle(repositories, run, lease, {
        status: "failed",
        error: workFailureMessage(outcome.cause),
        attempt: "failed",
      });
    });

    const exit = await Effect.runPromise(
      withRunFence(
        {
          runId: run.id,
          interval,
          heartbeat: heartbeatEffect(repositories, run.id, lease),
        },
        program,
      ).pipe(Effect.exit),
    );

    if (Exit.isSuccess(exit)) {
      return;
    }

    if (Cause.isInterrupted(exit.cause)) {
      return;
    }

    logger.warn("run execution ended without settling: the lease was lost", {
      fence: run.leaseFence,
    });

    // Best effort: the winner's reclaim almost certainly closed this attempt
    // already, and the `running` guard makes a second close harmless.
    try {
      await repositories.runs.abandonAttempt(
        run.id,
        run.leaseFence,
        "the worker lost the lease before the attempt settled",
      );
    } catch (error) {
      logger.warn("could not close the abandoned attempt", { error });
    }
  };
}

/**
 * One lease renewal as the fenced combinator wants it. Any failure — not only
 * the typed lease loss — is reported as a loss, because work cannot be
 * committed on a lease this process cannot prove it still holds (PRD decision
 * 26). The database's own error text is deliberately not carried.
 */
function heartbeatEffect(
  repositories: SystemRepositories,
  runId: string,
  lease: { readonly owner: string; readonly fence: number },
): Effect.Effect<void, LeaseLostError> {
  return Effect.tryPromise({
    try: async () => {
      await repositories.runs.heartbeat(runId, lease);
    },
    catch: (error) => (error instanceof LeaseLostError ? error : new LeaseLostError(runId)),
  });
}

/**
 * One fenced run write inside the heartbeat's scope, so the lease is renewed
 * right up to the settlement. A write that cannot be made is a lost lease as
 * far as this harness is concerned: the run stays where it is and the watchdog
 * recovers it.
 */
function settle(
  repositories: SystemRepositories,
  run: RunRecord,
  lease: { readonly owner: string; readonly fence: number },
  patch: FencedRunPatch,
): Effect.Effect<void, LeaseLostError> {
  return Effect.tryPromise({
    try: async () => {
      await repositories.runs.update(run.id, lease, patch);
    },
    catch: (error) => (error instanceof LeaseLostError ? error : new LeaseLostError(run.id)),
  });
}

function workFailureMessage(cause: Cause.Cause<unknown>): string {
  const failure = firstFailure(cause);

  if (failure instanceof Error && failure.message.trim() !== "") {
    return failure.message;
  }

  return "the run failed while it was executing";
}

function firstFailure(cause: Cause.Cause<unknown>): unknown {
  const failure = Cause.failureOption(cause);

  return Option.isSome(failure) ? failure.value : undefined;
}

function requiredOwner(run: RunRecord): string {
  const owner = run.leaseOwner;

  if (owner === null) {
    throw new Error(`run ${run.id} was acquired without a lease owner`);
  }

  return owner;
}
