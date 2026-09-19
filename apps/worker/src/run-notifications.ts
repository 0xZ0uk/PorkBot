import type { NotificationProvider } from "@porkbot/adapter-kit";
import { RUN_RECLAIM_FAILURES } from "@porkbot/core";
import type { NotificationKind, RunReclaimFailure } from "@porkbot/core";
import type { RunRecord, SystemRepositories } from "@porkbot/db";
import { createNotificationDelivery } from "@porkbot/effect";
import type { Logger } from "@porkbot/logging";

/**
 * The run-liveness notification producers (slice 8.7, PRD decision 33; story
 * 35).
 *
 * Every run state worth interrupting an operator for goes through this module:
 * a run that finished, a run that failed, a run whose worker timed out and
 * could not be resumed, and a run the watchdog found stuck. One message builder
 * and one delivery path serve all four, so a title, a body or a link is fixed
 * in one place and the E8 delivery path's preference check, retries and
 * outcomes are not re-implemented per producer.
 *
 * The claim decides, not the caller. A settled run claims its one terminal
 * notification in `run.notified_at` before anything is sent; a second caller —
 * a Graphile retry, a concurrent recovery producer — finds the claim taken and
 * sends nothing. A stall is claimed per episode by the `stalled_at` marker the
 * watchdog already writes, so a run that recovers and stalls again is announced
 * again while one long stall is announced once. Delivery failures are caught
 * and logged here: a broken notifier must never fail the run or the job that
 * produced the state.
 *
 * The link is the run's timeline: the thread console, addressed down to the run
 * itself. The provider is deployment-wide; the recipient check inside
 * `createNotificationDelivery` is the run's own space, which is why the
 * delivery is built per call rather than once at boot.
 */

/**
 * Where run notifications go: the provider that sends them and the absolute
 * origin the timeline link is built from. Both are deployment facts the
 * producers must not invent, so they arrive together from the composition root.
 */
export interface RunNotificationTarget {
  readonly provider: NotificationProvider;
  readonly origin: string;
}

export interface RunNotificationContext {
  /** The run's space, for the terminal claim and the recipient check. */
  readonly repositories: SystemRepositories;
  readonly logger: Logger;
  readonly target: RunNotificationTarget;
}

/** What a run that stopped making progress looked like when it was detected. */
export interface StallDetails {
  readonly stalledForMs: number;
  readonly tool: string | null;
}

interface RunNotificationMessage {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
}

/**
 * Delivers the one notification a run that settled `completed` or `failed`
 * may send. Returns without a message for every other state: a run still
 * running has nothing to announce yet, and a `cancelled` run is the operator's
 * own act, never an interruption back at them. The claim is taken before the
 * preference is read, so a quiet operator does not leave a run unclaimed for a
 * later producer to re-announce.
 */
export async function notifySettledRun(
  run: RunRecord,
  context: RunNotificationContext,
): Promise<void> {
  const message = settledMessage(run);

  if (message === null) {
    return;
  }

  if (!(await claim(run, context))) {
    return;
  }

  await deliver(run, message, context);
}

/**
 * Delivers the one notification a stall episode may send. The caller has
 * already won the durable episode marker (`stalled_at`), so this does not
 * claim again; it composes the sentence and hands it to the same path.
 */
export async function notifyStalledRun(
  run: RunRecord,
  stall: StallDetails,
  context: RunNotificationContext,
): Promise<void> {
  await deliver(
    run,
    {
      kind: "run.stalled",
      title: "A run has stalled",
      body: stallBody(stall.stalledForMs, stall.tool),
    },
    context,
  );
}

/**
 * The message for a terminal run. A reclaim failure is the timeout: the
 * worker that owned the run stopped heartbeating, the watchdog reclaimed it
 * and there was no checkpoint to resume, so the run is telling the operator
 * about a dead worker rather than about its own work. The `error_code` is the
 * closed vocabulary `@porkbot/core` owns; free-text errors never reach a
 * notification body.
 */
function settledMessage(run: RunRecord): RunNotificationMessage | null {
  switch (run.status) {
    case "completed":
      return {
        kind: "run.completed",
        title: "A run has finished",
        body: "The run finished successfully.",
      };

    case "failed":
      return run.errorCode !== null && isReclaimFailure(run.errorCode)
        ? {
            kind: "run.failed",
            title: "A run has timed out",
            body: "Its worker stopped responding and there was nothing to resume.",
          }
        : {
            kind: "run.failed",
            title: "A run has failed",
            body: "The run failed before it finished.",
          };

    default:
      return null;
  }
}

function isReclaimFailure(code: string): code is RunReclaimFailure {
  return (RUN_RECLAIM_FAILURES as readonly string[]).includes(code);
}

/**
 * The sentence the operator receives for a stall. It names the last step
 * (never a tool argument) and the silence in whole minutes, so the message
 * says what happened and how long it has been happening without carrying
 * anything from the run's own payloads.
 */
function stallBody(stalledForMs: number, tool: string | null): string {
  const minutes = Math.max(1, Math.round(stalledForMs / 60_000));
  const step = tool === null ? "running" : `running ${tool}`;

  return `No progress for ${minutes} minute${minutes === 1 ? "" : "s"} while ${step}.`;
}

/** The thread console — the run's timeline — addressed down to the run. */
function runUrl(origin: string, run: RunRecord): string {
  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;

  return `${base}/threads/${encodeURIComponent(run.threadId)}?run=${encodeURIComponent(run.id)}`;
}

/**
 * The durable, scoped, guarded claim. A failure to claim is logged and treated
 * as "someone else has it" rather than thrown: sending a message is never
 * worth failing the work that produced it, and the run state itself is already
 * durable.
 */
async function claim(run: RunRecord, context: RunNotificationContext): Promise<boolean> {
  try {
    return await context.repositories.runs.claimNotification(run.id);
  } catch (error) {
    context.logger.warn("could not claim a run notification", { runId: run.id, error });

    return false;
  }
}

async function deliver(
  run: RunRecord,
  message: RunNotificationMessage,
  context: RunNotificationContext,
): Promise<void> {
  const delivery = createNotificationDelivery({
    provider: context.target.provider,
    recipients: context.repositories.notifications,
    logger: context.logger,
  });

  try {
    const outcome = await delivery.deliver({
      recipientUserId: run.userId,
      kind: message.kind,
      title: message.title,
      body: message.body,
      url: runUrl(context.target.origin, run),
    });

    context.logger.info("run notification answered", {
      runId: run.id,
      kind: message.kind,
      outcome: outcome.status,
    });
  } catch (error) {
    context.logger.warn("could not deliver a run notification", {
      runId: run.id,
      kind: message.kind,
      error,
    });
  }
}
