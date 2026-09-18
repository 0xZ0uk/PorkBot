import type { RunStatus } from "@porkbot/core";
import { LeaseLostError } from "@porkbot/effect";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { runColumns } from "./records.ts";
import type { AttemptStatus, RunRecord } from "./records.ts";

/**
 * Workers renew every minute. The extra minute keeps a lease valid across
 * ordinary clock skew and a brief host suspend without delaying crash recovery
 * beyond two missed heartbeats.
 */
export const RUN_HEARTBEAT_INTERVAL_SECONDS = 60;
export const RUN_HEARTBEAT_GRACE_SECONDS = 60;
export const RUN_LEASE_TTL_SECONDS = RUN_HEARTBEAT_INTERVAL_SECONDS + RUN_HEARTBEAT_GRACE_SECONDS;

/**
 * How many expired leases one watchdog pass addresses. The scan is ordered
 * oldest-expiry-first, and a backlog larger than this drains on the next
 * interval rather than holding one job open indefinitely.
 */
export const RUN_WATCHDOG_BATCH_LIMIT = 50;

export interface RunLease {
  readonly owner: string;
  readonly fence: number;
}

/**
 * What a fenced run write may change. `attempt` settles the attempt row for the
 * lease's own fence in the same statement as the run change, so a finishing
 * worker cannot leave an attempt `running` behind a run it just completed.
 */
export interface FencedRunPatch {
  readonly status?: RunStatus;
  readonly checkpoint?: Readonly<Record<string, unknown>>;
  readonly error?: string | null;
  readonly errorCode?: string | null;
  readonly started?: boolean;
  readonly completed?: boolean;
  readonly attempt?: AttemptStatus;
}

/** Why a lease was reclaimed, and whether the reclaimer becomes its executor. */
export interface ReclaimOptions {
  /**
   * The operator-readable fact recorded on the attempt the reclaimer fences out
   * and on every tool-call row that was left in flight: the story a later audit
   * reads for why the work changed hands.
   */
  readonly reason: string;
  /**
   * Whether the reclaimer is about to execute the run. The watchdog reclaims to
   * decide and hand off, not to work, so it acquires the lease without leaving
   * an execution attempt it never ran; a resume handoff then records the
   * attempt under the executor's own fence.
   */
  readonly recordAttempt?: boolean;
}

/**
 * One expired lease the watchdog may reclaim. Addressing only: the run id, the
 * space whose scoped repositories will re-read it, the fence the expired owner
 * held, and when it expired.
 */
export interface ExpiredLease {
  readonly runId: string;
  readonly spaceId: string;
  readonly leaseFence: number;
  readonly leaseExpiresAt: Date;
}

/**
 * Claims an unowned queued run in one CAS. The attempt insert is part of the
 * same statement, so every successful fence has exactly one durable execution
 * record before the caller can do work.
 */
export async function claimRun(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  expectedFence: number,
  owner: string,
): Promise<RunRecord | undefined> {
  return acquireRun(actor, database, runId, expectedFence, owner, "claim");
}

/**
 * Reclaims an active run only after its previous owner's lease has expired.
 *
 * A reclaim is a successor, not a restart: the previous attempt is closed as
 * `abandoned` with the reason, and every tool-call row the previous owner left
 * in flight is settled as failed with the same reason, so a resumed run replays
 * a recorded outcome instead of running a possible side effect a second time.
 * All of it travels in the one statement as the lease CAS, so a reclaimer can
 * never observe its own lease without the reconciled records beside it.
 */
export async function reclaimRun(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  expectedFence: number,
  owner: string,
  options: ReclaimOptions,
): Promise<RunRecord | undefined> {
  return acquireRun(actor, database, runId, expectedFence, owner, "reclaim", options);
}

/**
 * Takes over a live lease from the exact owner that holds it — the handoff from
 * a reclaimer that decided the run must continue to the worker that will
 * execute it. The `previousOwner` guard is the whole safety story: only the
 * process holding `(expectedFence, previousOwner)` can start the next fence, a
 * duplicate delivery meets a moved owner, and a stale delivery meets a moved
 * fence. `lease_expires_at > now()` keeps a handoff prompt; a producer that
 * died before its handoff lands is recovered by the next reclaim instead.
 */
export async function adoptRun(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  expectedFence: number,
  owner: string,
  previousOwner: string,
): Promise<RunRecord | undefined> {
  return acquireRun(
    actor,
    database,
    runId,
    expectedFence,
    owner,
    "adopt",
    undefined,
    previousOwner,
  );
}

async function acquireRun(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  expectedFence: number,
  owner: string,
  mode: "claim" | "reclaim" | "adopt",
  options?: ReclaimOptions,
  previousOwner?: string,
): Promise<RunRecord | undefined> {
  const availability = availabilityGuard(mode);
  const startRun =
    mode === "claim" ? ", status = 'running', started_at = coalesce(started_at, now())" : "";
  const reason = mode === "reclaim" ? options?.reason : undefined;
  const recordAttempt = mode !== "reclaim" || options?.recordAttempt !== false;

  const values: unknown[] = [runId, actor.spaceId, expectedFence, owner, RUN_LEASE_TTL_SECONDS];
  if (mode === "adopt") {
    values.push(previousOwner);
  }

  const claimed =
    "with claimed as (" +
    "update run set lease_owner = $4, lease_fence = lease_fence + 1, " +
    `lease_expires_at = now() + make_interval(secs => $5), updated_at = now()${startRun} ` +
    `where id = $1 and space_id = $2 and lease_fence = $3 and ${availability} ` +
    `returning ${runColumns}` +
    ")";

  const recorded = recordAttempt
    ? ", recorded as (" +
      "insert into attempt (run_id, fence, status) " +
      "select id, \"leaseFence\", 'running'::attempt_status from claimed " +
      "returning run_id" +
      ")"
    : "";

  // A reclaim supersedes its predecessor: the attempt the old owner left
  // running is closed, and every tool-call row still in flight is settled as a
  // recorded failure so the resume cannot re-run a possible side effect.
  const reconciled =
    mode === "reclaim"
      ? ", abandoned as (" +
        "update attempt set status = 'abandoned'::attempt_status, error = $6, finished_at = now() " +
        "where run_id = $1 and fence = $3 and status = 'running' " +
        "and exists (select 1 from claimed) " +
        "returning id" +
        "), settled as (" +
        "update external_effect set status = 'failed'::effect_status, " +
        "result = jsonb_build_object('error', $6::text), updated_at = now() " +
        "where space_id = $2 and run_id = $1 and status in ('pending', 'running') " +
        "and exists (select 1 from claimed) " +
        "returning id" +
        ")"
      : "";

  const select = recordAttempt
    ? "select claimed.* from claimed join recorded on recorded.run_id = claimed.id"
    : "select claimed.* from claimed";

  const { rows } = await database.query<RunRecord>(claimed + recorded + reconciled + " " + select, [
    ...values,
    ...(mode === "reclaim" ? [reason ?? null] : []),
  ]);

  return rows[0];
}

function availabilityGuard(mode: "claim" | "reclaim" | "adopt"): string {
  switch (mode) {
    case "claim":
      return "status = 'queued' and lease_owner is null and lease_expires_at is null";
    case "reclaim":
      return (
        "status in ('running', 'waiting_approval') and lease_owner is not null " +
        "and lease_expires_at <= now()"
      );
    case "adopt":
      return (
        "status in ('running', 'waiting_approval') and lease_owner = $6 " +
        "and lease_expires_at > now()"
      );
  }
}

/**
 * The watchdog's scan: every active run whose lease has expired, oldest expiry
 * first.
 *
 * This is the one deliberate cross-space read in the package, and it is the
 * deliberate exception to the "no query without the actor's space" rule for the
 * same reason `readDeploymentSettings` is: a lease recovery path cannot start
 * from an actor, because the actor it needs is derived from the row it has not
 * found yet. It returns addressing only — no checkpoint, no prompt, no work —
 * and every follow-up write goes through the `SystemActor` its `spaceId` names,
 * so the scope is still enforced one step later. It takes no space id as an
 * argument and cannot be reached through `createRepositories`.
 */
export async function findExpiredLeases(
  database: Queryable,
  limit: number = RUN_WATCHDOG_BATCH_LIMIT,
): Promise<readonly ExpiredLease[]> {
  const { rows } = await database.query<ExpiredLease>(
    'select id as "runId", space_id as "spaceId", lease_fence as "leaseFence", ' +
      'lease_expires_at as "leaseExpiresAt" from run ' +
      "where status in ('running', 'waiting_approval') and lease_owner is not null " +
      "and lease_expires_at <= now() " +
      "order by lease_expires_at asc, id asc limit $1",
    [limit],
  );

  return rows;
}

/**
 * The sentence a reclaim records on the attempt and tool-call rows it fences
 * out. It is built from the expired timestamp the row still carries when the
 * reclaimer reads it, so an audit can tell how long the run sat stranded; a
 * timestamp of `null` only happens for a row that was never claimed, which a
 * reclaim cannot observe.
 */
export function expiredLeaseReason(expiresAt: Date | null): string {
  if (expiresAt === null) {
    return "the previous owner's lease expired and no heartbeat renewed it";
  }

  return (
    `the previous owner's lease expired at ${expiresAt.toISOString()} ` +
    "and no heartbeat renewed it"
  );
}

/** Renews only the exact lease the caller owns; a stale owner loses cleanly. */
export async function heartbeatRun(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  lease: RunLease,
): Promise<RunRecord> {
  const { rows } = await database.query<RunRecord>(
    "update run set lease_expires_at = now() + make_interval(secs => $5), updated_at = now() " +
      "where id = $1 and space_id = $2 and lease_owner = $3 and lease_fence = $4 " +
      "and status in ('running', 'waiting_approval') and lease_expires_at > now() " +
      `returning ${runColumns}`,
    [runId, actor.spaceId, lease.owner, lease.fence, RUN_LEASE_TTL_SECONDS],
  );

  return ownedRow(rows, runId);
}

/**
 * The only general worker write to a run. Owner and fence are mandatory, so a
 * superseded execution cannot publish a checkpoint or transition the run.
 */
export async function updateClaimedRun(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  lease: RunLease,
  patch: FencedRunPatch,
): Promise<RunRecord> {
  const values: unknown[] = [];
  const assignments = ["updated_at = now()"];

  addAssignment(values, assignments, "status", patch.status, "::run_status");
  addAssignment(
    values,
    assignments,
    "checkpoint",
    patch.checkpoint === undefined ? undefined : JSON.stringify(patch.checkpoint),
    "::jsonb",
  );
  addAssignment(values, assignments, "error", patch.error);
  addAssignment(values, assignments, "error_code", patch.errorCode);

  if (patch.started === true) {
    assignments.push("started_at = coalesce(started_at, now())");
  }

  if (patch.completed === true) {
    assignments.push("completed_at = now()");
  }

  values.push(runId, actor.spaceId, lease.owner, lease.fence);
  const firstGuard = values.length - 3;

  let attemptStatus = 0;
  let attemptError = 0;

  if (patch.attempt !== undefined) {
    values.push(patch.attempt);
    attemptStatus = values.length;
    values.push(patch.error ?? null);
    attemptError = values.length;
  }

  const transitionGuard = statusTransitionGuard(patch.status);
  const updated =
    `with updated as (update run set ${assignments.join(", ")} ` +
    `where id = $${firstGuard} and space_id = $${firstGuard + 1} ` +
    `and lease_owner = $${firstGuard + 2} and lease_fence = $${firstGuard + 3} ` +
    "and lease_expires_at > now() and status in ('running', 'waiting_approval') " +
    transitionGuard +
    `returning ${runColumns})`;

  const settled =
    patch.attempt === undefined
      ? ""
      : ", settled as (" +
        `update attempt set status = $${attemptStatus}::attempt_status, error = $${attemptError}, ` +
        "finished_at = now() " +
        `where run_id = $${firstGuard} and fence = $${firstGuard + 3} and status = 'running' ` +
        "and exists (select 1 from updated) " +
        "returning id)";

  const { rows } = await database.query<RunRecord>(
    updated + settled + " select updated.* from updated",
    values,
  );

  return ownedRow(rows, runId);
}

/**
 * Closes the attempt the caller's own fence recorded, after the caller learned
 * it no longer owns the run. This is best-effort bookkeeping, not a run write:
 * the winner already abandoned the row if it reclaimed, and the `status =
 * 'running'` guard makes a second close a no-op. The run's space is checked
 * through the run row because `attempt` carries no space of its own.
 */
export async function abandonAttempt(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  fence: number,
  reason: string,
): Promise<boolean> {
  const { rows } = await database.query<{ readonly id: string }>(
    "update attempt set status = 'abandoned'::attempt_status, error = $4, finished_at = now() " +
      "where run_id = $1 and fence = $2 and status = 'running' " +
      "and exists (select 1 from run r where r.id = $1 and r.space_id = $3) " +
      "returning id",
    [runId, fence, actor.spaceId, reason],
  );

  return rows.length > 0;
}

function statusTransitionGuard(status: RunStatus | undefined): string {
  switch (status) {
    case undefined:
      return "";
    case "running":
      return "and status = 'waiting_approval' ";
    case "waiting_approval":
    case "completed":
      return "and status = 'running' ";
    case "failed":
    case "cancelled":
      return "and status in ('running', 'waiting_approval') ";
    case "queued":
      // No active run may transition back to queued.
      return "and false ";
  }
}

function addAssignment(
  values: unknown[],
  assignments: string[],
  column: string,
  value: unknown,
  cast = "",
): void {
  if (value === undefined) {
    return;
  }

  values.push(value);
  assignments.push(`${column} = $${values.length}${cast}`);
}

function ownedRow(rows: readonly RunRecord[], runId: string): RunRecord {
  const row = rows[0];
  if (row === undefined) {
    throw new LeaseLostError(runId);
  }

  return row;
}
