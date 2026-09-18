import { decideReclaim, isActiveStatus, reclaimFailureMessage } from "@porkbot/core";
import {
  createRepositories,
  expiredLeaseReason,
  findExpiredLeases,
  RUN_WATCHDOG_BATCH_LIMIT,
} from "@porkbot/db";
import type { Queryable, RunRecord, SystemRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import { JobPayloadError } from "../job-registry.ts";
import type { JobContext, JobDefinition } from "../job-registry.ts";
import { systemActorForJob } from "../system-actor.ts";
import { runExecuteIdentifier } from "./run-execute.ts";

/**
 * The lease watchdog (slice 6.3, PRD decisions 25 and 26): the minute-interval
 * job that finds active runs whose owner stopped renewing and reclaims them.
 *
 * The scan is deliberately global and the reclaim is deliberately scoped: one
 * cross-space read finds the expired addressing rows, and every write after it
 * goes through a `SystemActor` for the space the row names, exactly as if a job
 * payload had named it. That keeps the "handlers receive an actor, never a
 * tenant id" rule intact — the watchdog derives the actor from the row rather
 * than being handed one — and is why `findExpiredLeases` is exported beside the
 * lease module instead of through `createRepositories`.
 *
 * The reclaim itself is the same CAS every other reclaimer uses, so two
 * watchdogs (or a watchdog and a late delivery) racing the same row produce one
 * winner, and the loser writes nothing. What the watchdog adds is the decision
 * after the lease changes hands: a stored checkpoint is handed to the executor
 * as a resume, and a run that stopped before its first checkpoint is failed
 * with the typed reason rather than silently restarted. The handoff names the
 * watchdog as the previous owner, and the executor adopts the live lease by
 * that exact pair — so the resume cannot be stolen by a stale delivery.
 *
 * The watchdog never executes and never records an execution attempt of its
 * own: it reclaims with `recordAttempt: false`, and the executor's adoption
 * records the attempt it will actually run.
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

export interface LeaseWatchdogOptions {
  /** How many expired leases one pass addresses. Defaults to the shared batch limit. */
  readonly batchLimit?: number;
}

export function leaseWatchdogJob(
  options: LeaseWatchdogOptions = {},
): JobDefinition<LeaseWatchdogPayload> {
  const batchLimit = options.batchLimit ?? RUN_WATCHDOG_BATCH_LIMIT;

  return {
    identifier: leaseWatchdogIdentifier,
    parse: parseLeaseWatchdogPayload,
    async handle(_payload, context): Promise<void> {
      await context.withPgClient(async (client) => {
        const expired = await findExpiredLeases(client, batchLimit);

        if (expired.length === 0) {
          context.logger.info("lease watchdog pass found no expired lease", { batchLimit });
          return;
        }

        let resumed = 0;
        let failed = 0;

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

        context.logger.info("lease watchdog pass complete", {
          scanned: expired.length,
          resumed,
          failed,
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
