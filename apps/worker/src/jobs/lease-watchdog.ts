import {
  assessRunLiveness,
  isActiveStatus,
  decideReclaim,
  reclaimFailureMessage,
  RUN_STALL_THRESHOLD_SECONDS,
} from "@porkbot/core";
import type { NotificationProvider } from "@porkbot/adapter-kit";
import {
  createRepositories,
  expiredLeaseReason,
  findExpiredLeases,
  findStalledRuns,
  RUN_WATCHDOG_BATCH_LIMIT,
} from "@porkbot/db";
import type { Queryable, RunRecord, SystemRepositories } from "@porkbot/db";
import { createNotificationDelivery, NotFoundError } from "@porkbot/effect";
import { JobPayloadError } from "../job-registry.ts";
import type { JobContext, JobDefinition } from "../job-registry.ts";
import { systemActorForJob } from "../system-actor.ts";
import { runExecuteIdentifier } from "./run-execute.ts";

/**
 * The lease watchdog (slices 6.3 and 6.10, PRD decisions 25, 26 and 33): the
 * minute-interval job that finds runs whose owner stopped renewing and reclaims
 * them, and runs whose owner is alive but whose progress stopped and marks
 * them.
 *
 * The two passes answer different questions from the same row. An expired lease
 * is a dead worker: reclaim it, resume from its checkpoint or fail it with a
 * typed reason. A live lease with stale progress is a hang: the process is
 * healthy, the run is not, and the stall marker plus the E8 notification are
 * the operator's signal — the run itself is left for its owner to interrupt or
 * for the lease to lapse.
 *
 * The scan is deliberately global and the writes are deliberately scoped: one
 * cross-space read finds the addressing rows, and every write after it goes
 * through a `SystemActor` for the space the row names, exactly as if a job
 * payload had named it. That keeps the "handlers receive an actor, never a
 * tenant id" rule intact — the watchdog derives the actor from the row rather
 * than being handed one — and is why `findExpiredLeases` and `findStalledRuns`
 * are exported beside their stores instead of through `createRepositories`.
 *
 * The stall decision itself is the one in `@porkbot/core`, rendered here
 * against the row the marker just returned; the durable `stalled_at` guard is
 * what makes the notification exactly once per episode, and the heartbeat that
 * reports renewed progress clears it. The delivery target is the E8 path
 * (`NotificationDelivery`), injected because slice 8.7 owns the composition of
 * the HTTP provider and the link's origin; without one, a stall is still
 * recorded and logged.
 */

export const leaseWatchdogIdentifier = "run.watchdog";

/**
 * The payload carries nothing: the watchdog addresses no run and receives no
 * work. Graphile's cron scheduler adds a `_cron` marker to deliveries it
 * schedules, so that one field is tolerated and dropped; anything else is a
 * producer smuggling work into a payload that has no use for it.
 */
export type LeaseWatchdogPayload = Record<never, never>;

export function parseLeaseWatchdogPayload(payload: unknown): LeaseWatchdogPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new JobPayloadError(leaseWatchdogIdentifier, "must be an object");
  }

  for (const key of Object.keys(payload)) {
    if (key !== "_cron") {
      throw new JobPayloadError(
        leaseWatchdogIdentifier,
        `carries "${key}"; the watchdog addresses no run and never carries work`,
      );
    }
  }

  return {};
}

/**
 * Where a stall notification goes: the provider that sends it and the absolute
 * origin the run's thread link is built from. Both are deployment facts the job
 * must not invent, so they arrive together from the composition root. The
 * delivery path itself is built per candidate, because its recipient check is
 * scoped to the run's space and this job deliberately spans spaces; slice 8.7
 * owns the HTTP provider's configuration.
 */
export interface StallNotificationTarget {
  readonly provider: NotificationProvider;
  readonly origin: string;
}

export interface LeaseWatchdogOptions {
  /** How many candidates one pass addresses. Defaults to the shared batch limit. */
  readonly batchLimit?: number;
  /** How long a run may go without progress before it is stalled. */
  readonly stallThresholdSeconds?: number;
  /**
   * The E8 delivery path. Absent, a detected stall is marked and logged but no
   * notification is sent; slice 8.7 composes the provider.
   */
  readonly stallNotification?: StallNotificationTarget;
}

export function leaseWatchdogJob(
  options: LeaseWatchdogOptions = {},
): JobDefinition<LeaseWatchdogPayload> {
  const batchLimit = options.batchLimit ?? RUN_WATCHDOG_BATCH_LIMIT;
  const stallThresholdSeconds = options.stallThresholdSeconds ?? RUN_STALL_THRESHOLD_SECONDS;

  return {
    identifier: leaseWatchdogIdentifier,
    parse: parseLeaseWatchdogPayload,
    async handle(_payload, context): Promise<void> {
      await context.withPgClient(async (client) => {
        const expired = await findExpiredLeases(client, batchLimit);
        const stalled = await findStalledRuns(client, stallThresholdSeconds, batchLimit);

        if (expired.length === 0 && stalled.length === 0) {
          context.logger.info("lease watchdog pass found no expired lease", { batchLimit });
          return;
        }

        let resumed = 0;
        let failed = 0;
        let marked = 0;

        for (const candidate of expired) {
          const outcome = await reclaimCandidate(
            candidate.spaceId,
            candidate.runId,
            context,
            client,
          );

          if (outcome === "resumed") {
            resumed += 1;
          } else if (outcome === "failed") {
            failed += 1;
          }
        }

        for (const candidate of stalled) {
          const run = await recordStall(
            candidate.spaceId,
            candidate.runId,
            context,
            client,
            stallThresholdSeconds,
          );

          if (run === undefined) {
            continue;
          }

          marked += 1;
          await notifyStall(run, context, client, options, stallThresholdSeconds);
        }

        context.logger.info("lease watchdog pass complete", {
          scanned: expired.length,
          resumed,
          failed,
          stalled: stalled.length,
          marked,
        });
      });
    },
  };
}

type CandidateOutcome = "resumed" | "failed" | "skipped";

async function reclaimCandidate(
  spaceId: string,
  runId: string,
  context: JobContext,
  client: Queryable,
): Promise<CandidateOutcome> {
  const logger = context.logger.child({ runId });
  const actor = systemActorForJob({ jobId: context.jobId, spaceId });
  const repositories = createRepositories(actor, client);
  const run = await readRun(repositories, runId, logger);

  if (run === undefined || !isExpired(run)) {
    return "skipped";
  }

  const reason = expiredLeaseReason(run.leaseExpiresAt);
  const claimed = await repositories.runs.reclaim(run.id, run.leaseFence, context.jobId, {
    reason,
    recordAttempt: false,
  });

  if (claimed === undefined) {
    logger.info("lease watchdog skipped a run another reclaimer owns", {
      fence: run.leaseFence,
    });
    return "skipped";
  }

  const decision = decideReclaim(claimed.checkpoint);

  if (!decision.resume) {
    await failRun(repositories, claimed, decision.reason);
    logger.warn("lease watchdog failed a reclaimed run with nothing to resume", {
      fence: claimed.leaseFence,
      reason: decision.reason,
    });
    return "failed";
  }

  await context.enqueue(
    runExecuteIdentifier,
    {
      runId: claimed.id,
      spaceId: claimed.spaceId,
      fence: claimed.leaseFence,
      owner: context.jobId,
    },
    // A newer handoff for the same run must replace a pending older one: the
    // payloads differ by fence, and the older payload addresses a fence the
    // row has already left.
    { jobKey: `${runExecuteIdentifier}:${claimed.id}`, jobKeyMode: "replace" },
  );

  logger.info("lease watchdog reclaimed an expired lease and queued the resume", {
    fence: claimed.leaseFence,
    reason,
  });
  return "resumed";
}

/**
 * Freezes one stall episode and returns the marked row, or undefined when the
 * run moved on between the scan and the write. The row is re-read inside its
 * scope first — the scan and the mark are two instants, and a run that is not
 * in the space or has already progressed is not this candidate's to mark.
 */
async function recordStall(
  spaceId: string,
  runId: string,
  context: JobContext,
  client: Queryable,
  thresholdSeconds: number,
): Promise<RunRecord | undefined> {
  const logger = context.logger.child({ runId });
  const actor = systemActorForJob({ jobId: context.jobId, spaceId });
  const repositories = createRepositories(actor, client);
  const run = await readRun(repositories, runId, logger);

  if (run === undefined) {
    return undefined;
  }

  const marked = await repositories.runs.markStalled(run.id, thresholdSeconds);

  if (marked === undefined) {
    logger.info("lease watchdog skipped a run that moved on before it could be marked", {});
    return undefined;
  }

  logger.warn("lease watchdog found a run making no progress", {
    fence: marked.leaseFence,
    step: marked.currentStep,
  });
  return marked;
}

/**
 * Sends at most one notification per stall episode. The episode marker is
 * already durable, so a delivery failure loses this message rather than
 * re-sending it on every later pass; the outcome is logged either way, and an
 * unclassified adapter error is caught here because a broken notifier must not
 * fail the recovery job.
 *
 * The delivery is built per run so its recipient check is the run's own
 * space — the provider is deployment-wide, the preference read is not.
 */
async function notifyStall(
  run: RunRecord,
  context: JobContext,
  client: Queryable,
  options: LeaseWatchdogOptions,
  thresholdSeconds: number,
): Promise<void> {
  const target = options.stallNotification;

  if (target === undefined) {
    return;
  }

  const actor = systemActorForJob({ jobId: context.jobId, spaceId: run.spaceId });
  const repositories = createRepositories(actor, client);
  const delivery = createNotificationDelivery({
    provider: target.provider,
    recipients: repositories.notifications,
  });
  const liveness = assessRunLiveness(run, new Date(), thresholdSeconds);
  const stalledForMs = liveness?.sinceProgressMs ?? 0;
  const tool = liveness?.tool ?? null;

  try {
    const outcome = await delivery.deliver({
      recipientUserId: run.userId,
      kind: "run.stalled",
      title: "A run has stalled",
      body: stallBody(stalledForMs, tool),
      url: `${target.origin}/threads/${run.threadId}`,
    });

    context.logger.info("lease watchdog answered a stall notification", {
      runId: run.id,
      outcome: outcome.status,
    });
  } catch (error) {
    context.logger.warn("lease watchdog could not deliver a stall notification", {
      runId: run.id,
      error,
    });
  }
}

/**
 * The sentence the operator receives. It names the last step (never a tool
 * argument) and the silence in whole minutes, so the message says what happened
 * and how long it has been happening without carrying anything from the run's
 * own payloads.
 */
function stallBody(stalledForMs: number, tool: string | null): string {
  const minutes = Math.max(1, Math.round(stalledForMs / 60_000));
  const step = tool === null ? "running" : `running ${tool}`;

  return `No progress for ${minutes} minute${minutes === 1 ? "" : "s"} while ${step}.`;
}

async function failRun(
  repositories: SystemRepositories,
  run: RunRecord,
  reason: Parameters<typeof reclaimFailureMessage>[0],
): Promise<void> {
  const owner = run.leaseOwner;

  if (owner === null) {
    throw new Error(`run ${run.id} was reclaimed without a lease owner`);
  }

  await repositories.runs.update(
    run.id,
    { owner, fence: run.leaseFence },
    {
      status: "failed",
      error: reclaimFailureMessage(reason),
      errorCode: reason,
      completed: true,
    },
  );
}

/** The scoped read; a run in another space is the same not-found as a missing one. */
async function readRun(
  repositories: SystemRepositories,
  runId: string,
  logger: { info: (message: string, fields: Record<string, unknown>) => void },
): Promise<RunRecord | undefined> {
  try {
    return await repositories.runs.findById(runId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      logger.info("lease watchdog skipped a run outside the candidate's space", {});
      return undefined;
    }

    throw error;
  }
}

/**
 * The row is re-read inside its scope before it is touched, because the scan
 * and the reclaim are two different instants: an owner that heartbeated in
 * between, a run that reached a terminal state, and a reclaim by another
 * watchdog all mean this candidate is no longer expired, and the reclaim's own
 * guard would say so anyway — the check saves the round trip and keeps the
 * decision and the CAS reading the same row.
 *
 * This check reads the worker host's clock while the reclaim's guard compares
 * against the database's, so the two can disagree by the skew between them.
 * That is deliberately safe in both directions: a run this process thinks is
 * still live is simply picked up on the next minute's pass, and a run it thinks
 * is expired is refused by the CAS if the server disagrees. The SQL guard is
 * the authority; this is a fast path, not a second policy.
 */
function isExpired(run: RunRecord): boolean {
  return (
    isActiveStatus(run.status) &&
    run.leaseOwner !== null &&
    run.leaseExpiresAt !== null &&
    run.leaseExpiresAt.getTime() <= Date.now()
  );
}
