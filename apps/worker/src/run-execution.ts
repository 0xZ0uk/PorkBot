import { Cause, Effect, Exit, Option } from "effect";
import { createRunProgress } from "@porkbot/core";
import type { RunProgress } from "@porkbot/core";
import { RUN_HEARTBEAT_INTERVAL_SECONDS } from "@porkbot/db";
import type { FencedRunPatch, RunRecord, SystemRepositories } from "@porkbot/db";
import { LeaseLostError, withRunFence } from "@porkbot/effect";
import type { RunSessionOutcome } from "@porkbot/effect";
import type { RunExecution, RunExecutor } from "./jobs/run-execute.ts";
import { notifySettledRun } from "./run-notifications.ts";
import type { RunNotificationTarget } from "./run-notifications.ts";

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

/**
 * The execution a run's work receives: the acquired row plus the progress
 * recorder the harness stamps onto every heartbeat (slice 6.10). The work notes
 * each session event exactly where it records it, so the durable row reports
 * the same step the client's reducer shows; the assessment itself lives in
 * `@porkbot/core` and is shared with the notification path.
 */
export interface RunWorkExecution extends RunExecution {
  readonly progress: RunProgress;
}

/**
 * A run's work. It reports how the session ended — the same outcome
 * `consumeRunSession` returns — and the harness settles the row from it. A
 * work failure is still classified by the harness; it never reaches a client.
 */
export type RunWork = (execution: RunWorkExecution) => Effect.Effect<RunSessionOutcome, unknown>;

export interface RunExecutionOptions {
  readonly work: RunWork;
  /**
   * How long between lease renewals. Defaults to the shared heartbeat
   * interval; tests shorten it so a lost lease interrupts promptly.
   */
  readonly heartbeatIntervalMs?: number;
  /**
   * The E8 delivery path (slice 8.7). Absent, a settled run is recorded and
   * logged but no notification is sent; the composition root supplies the
   * provider and the link's origin.
   */
  readonly notificationTarget?: RunNotificationTarget;
}

export function createRunExecutor(options: RunExecutionOptions): RunExecutor {
  const interval = options.heartbeatIntervalMs ?? RUN_HEARTBEAT_INTERVAL_SECONDS * 1000;

  return async (execution) => {
    const { run, repositories, logger } = execution;
    const lease = { owner: requiredOwner(run), fence: run.leaseFence };
    const progress = createRunProgress();

    const program = Effect.gen(function* () {
      const outcome = yield* options.work({ ...execution, progress }).pipe(Effect.exit);

      if (Exit.isSuccess(outcome)) {
        const settled = yield* settle(repositories, run, lease, settlement(outcome.value));
        yield* releaseComputer(repositories, run, lease);
        yield* notify(settled, execution, options.notificationTarget);
        return;
      }

      // An interrupt or a lost-lease failure means this process no longer owns
      // the run: it must not write a terminal state another owner may hold, and
      // it must not release a computer lease a live command may still be using.
      // The lease's TTL is the bound on that window, and the watchdog sweeps
      // what it leaves behind.
      if (
        Cause.isInterrupted(outcome.cause) ||
        firstFailure(outcome.cause) instanceof LeaseLostError
      ) {
        return yield* Effect.fail(new LeaseLostError(run.id));
      }

      const settled = yield* settle(repositories, run, lease, {
        status: "failed",
        error: workFailureMessage(outcome.cause),
        attempt: "failed",
        completed: true,
        release: true,
      });
      yield* releaseComputer(repositories, run, lease);
      yield* notify(settled, execution, options.notificationTarget);
    });

    const exit = await Effect.runPromise(
      withRunFence(
        {
          runId: run.id,
          interval,
          heartbeat: heartbeatEffect(repositories, run.id, lease, progress),
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
 * The fenced patch a session outcome settles into. Every terminal settlement
 * releases the lease in the same write (slice 6.7): a finished run is nobody's
 * lease, and a cancelled one — the operator's stop, or a session that ended in
 * `run.cancelled` for another reason — settles as `cancelled` with its own
 * attempt status, never as a completion the operator did not ask for.
 *
 * A cancellation or a failure can end a run while a tool call is in flight, so
 * both settle the calls in the same statement. Nothing will resume a terminal
 * run, and a claim left open would read as in flight forever — the half-
 * committed effect the stop is supposed to leave none of. A completion carries
 * no such reason: a session that completed while a call was open is a bug, not
 * a reconciliation.
 */
function settlement(outcome: RunSessionOutcome): FencedRunPatch {
  switch (outcome.status) {
    case "completed":
      return { status: "completed", completed: true, attempt: "completed", release: true };

    case "cancelled":
      return {
        status: "cancelled",
        errorCode: "cancelled",
        completed: true,
        attempt: "cancelled",
        release: true,
        settleInFlight: "the run was cancelled before this tool call settled",
      };

    case "failed":
      return {
        status: "failed",
        error: outcome.error,
        errorCode: outcome.code ?? null,
        completed: true,
        attempt: "failed",
        release: true,
        settleInFlight: "the run failed before this tool call settled",
      };
  }
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
  progress: RunProgress,
): Effect.Effect<void, LeaseLostError> {
  return Effect.tryPromise({
    try: async () => {
      await repositories.runs.heartbeat(runId, lease, progress.snapshot());
    },
    catch: (error) => (error instanceof LeaseLostError ? error : new LeaseLostError(runId)),
  });
}

/**
 * One fenced run write inside the heartbeat's scope, so the lease is renewed
 * right up to the settlement. A write that cannot be made is a lost lease as
 * far as this harness is concerned: the run stays where it is and the watchdog
 * recovers it. The settled row is returned because the notification step reads
 * its final status and `error_code`, never the patch this process intended.
 */
function settle(
  repositories: SystemRepositories,
  run: RunRecord,
  lease: { readonly owner: string; readonly fence: number },
  patch: FencedRunPatch,
): Effect.Effect<RunRecord, LeaseLostError> {
  return Effect.tryPromise({
    try: async () => repositories.runs.update(run.id, lease, patch),
    catch: (error) => (error instanceof LeaseLostError ? error : new LeaseLostError(run.id)),
  });
}

/**
 * The computer lease a settled run no longer needs (slice 7.4). A terminal run
 * has no in-flight command — the work that owned the machine finished — so the
 * row is cleared immediately rather than left for the TTL and the watchdog.
 * The owner and fence are this execution's own, so the release can only clear
 * the binding this fence wrote; a lease the reclaim already moved is untouched.
 *
 * It never fails the settlement: the run's outcome is durable, and a release
 * that cannot be made is a row the watchdog sweeps once it expires.
 */
function releaseComputer(
  repositories: SystemRepositories,
  run: RunRecord,
  lease: { readonly owner: string; readonly fence: number },
): Effect.Effect<void> {
  return Effect.tryPromise(() =>
    repositories.computerLeases.release({
      botId: run.botId,
      runId: run.id,
      owner: lease.owner,
      fence: lease.fence,
    }),
  ).pipe(Effect.catchAllCause(() => Effect.void));
}

/**
 * The notification step of a settlement. It never fails: a run must not read
 * as lease-lost, and a job must not be retried, because an operator could not
 * be told about a state that is already durable. The claim inside
 * `notifySettledRun` is what makes a retry harmless, and the catch here keeps
 * an unexpected defect in the notifier from interrupting the settlement's
 * scope.
 */
function notify(
  run: RunRecord,
  execution: RunExecution,
  target: RunNotificationTarget | undefined,
): Effect.Effect<void> {
  if (target === undefined) {
    return Effect.void;
  }

  return Effect.tryPromise(() =>
    notifySettledRun(run, {
      repositories: execution.repositories,
      logger: execution.logger,
      target,
    }),
  ).pipe(Effect.catchAllCause(() => Effect.void));
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
