import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { runColumns } from "./records.ts";
import type { RunRecord } from "./records.ts";
import { RUN_WATCHDOG_BATCH_LIMIT } from "./run-leases.ts";

/**
 * The durable half of run-liveness detection and its notification claims
 * (slices 6.10 and 8.7, PRD decision 33).
 *
 * A stalled run is not one whose lease expired — that is the watchdog's reclaim
 * path — but one whose worker is alive and renewing while the run itself has
 * emitted nothing past the stall threshold. `findStalledRuns` asks the first
 * question globally (the same deliberate cross-space exception
 * `findExpiredLeases` documents: a recovery path cannot start from an actor it
 * has not derived yet) and returns addressing only; `markRunStalled` records
 * the episode in the candidate's own space, guarded so exactly one detector
 * wins.
 *
 * `stalled_at` is the episode marker, not the detection: the console renders
 * "stuck" from the progress age alone, and the marker exists so the
 * notification path delivers one message per episode rather than one per
 * minute. A heartbeat that reports progress clears it in the same statement
 * that renews the lease.
 *
 * `notified_at` is the terminal notification's claim: the run row's one
 * announcement that it finished or failed. The guarded write below is what
 * makes duplicate suppression structural rather than incidental — whichever
 * producer settles the run claims before it sends, and a second caller finds
 * the claim already taken.
 */

/** One run whose worker is alive but whose progress has stopped. */
export interface StalledRun {
  readonly runId: string;
  readonly spaceId: string;
}

/**
 * Every running run whose lease is still held, whose stop was not requested,
 * whose step is not a parked approval, and whose last progress is strictly
 * older than the threshold. Oldest-silence-first, bounded like the lease scan.
 *
 * The threshold travels as a parameter rather than a constant so the caller's
 * policy (core's `RUN_STALL_THRESHOLD_SECONDS`, or a test's injected clock)
 * is the one applied; the clock is the database's, so a worker host's clock
 * cannot make a healthy run look stalled. A row with no progress baseline is
 * never a candidate: it was claimed by a version that did not measure
 * liveness, and calling its age a stall would flag a healthy run. The strict
 * comparison is the same one `assessRunLiveness` makes, so a candidate the
 * scan returns is a run the assessment calls stuck.
 */
export async function findStalledRuns(
  database: Queryable,
  thresholdSeconds: number,
  limit: number = RUN_WATCHDOG_BATCH_LIMIT,
): Promise<readonly StalledRun[]> {
  const { rows } = await database.query<StalledRun>(
    'select id as "runId", space_id as "spaceId" from run ' +
      "where status = 'running' and lease_owner is not null and lease_expires_at > now() " +
      "and stop_requested_at is null and stalled_at is null " +
      "and current_step is distinct from 'waiting' and last_progress_at is not null " +
      "and last_progress_at < now() - make_interval(secs => $1) " +
      "order by last_progress_at asc, id asc limit $2",
    [thresholdSeconds, limit],
  );

  return rows;
}

/**
 * Records the start of one stall episode, in the run's own space and only while
 * the facts that made it a candidate still hold. The guards are the whole
 * exactly-once story: a run that progressed, parked on an approval, was asked
 * to stop, lost its lease, was already marked, or never had a progress
 * baseline between the scan and this write matches nothing, and `undefined`
 * tells the caller it lost the race.
 */
export async function markRunStalled(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  thresholdSeconds: number,
): Promise<RunRecord | undefined> {
  const { rows } = await database.query<RunRecord>(
    "update run set stalled_at = now(), updated_at = now() " +
      "where id = $1 and space_id = $2 and status = 'running' " +
      "and lease_owner is not null and lease_expires_at > now() " +
      "and stop_requested_at is null and stalled_at is null " +
      "and current_step is distinct from 'waiting' and last_progress_at is not null " +
      "and last_progress_at < now() - make_interval(secs => $3) " +
      `returning ${runColumns}`,
    [runId, actor.spaceId, thresholdSeconds],
  );

  return rows[0];
}

/**
 * Claims the run's one terminal notification (slice 8.7): true for the caller
 * that set `notified_at`, false when it was already claimed, the run is not
 * terminal, or the run is outside the actor's space. The status guard lives
 * here rather than at the call sites so a `cancelled` run — the operator's own
 * act — can never be announced, whichever producer asks.
 *
 * The claim is durable and independent of any delivery: a process that claims
 * and then dies loses that message rather than re-sending it on a later pass.
 * That is the delivery path's stated trade — bounded retries, then one final
 * outcome — and it keeps a broken notifier from turning one finished run into a
 * message per recovery pass.
 */
export async function claimRunNotification(
  actor: SystemActor,
  database: Queryable,
  runId: string,
): Promise<boolean> {
  const { rows } = await database.query<{ readonly id: string }>(
    "update run set notified_at = now(), updated_at = now() " +
      "where id = $1 and space_id = $2 and notified_at is null " +
      "and status in ('completed', 'failed') returning id",
    [runId, actor.spaceId],
  );

  return rows.length > 0;
}
