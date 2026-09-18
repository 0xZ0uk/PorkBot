import type { RunStatus } from "@porkbot/core";
import { LeaseLostError } from "@porkbot/effect";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { runColumns } from "./records.ts";
import type { RunRecord } from "./records.ts";

/**
 * Workers renew every minute. The extra minute keeps a lease valid across
 * ordinary clock skew and a brief host suspend without delaying crash recovery
 * beyond two missed heartbeats.
 */
export const RUN_HEARTBEAT_INTERVAL_SECONDS = 60;
export const RUN_HEARTBEAT_GRACE_SECONDS = 60;
export const RUN_LEASE_TTL_SECONDS = RUN_HEARTBEAT_INTERVAL_SECONDS + RUN_HEARTBEAT_GRACE_SECONDS;

export interface RunLease {
  readonly owner: string;
  readonly fence: number;
}

export interface FencedRunPatch {
  readonly status?: RunStatus;
  readonly checkpoint?: Readonly<Record<string, unknown>>;
  readonly error?: string | null;
  readonly errorCode?: string | null;
  readonly started?: boolean;
  readonly completed?: boolean;
}

/**
 * Claims an unowned queued run, or reclaims an expired active run, in one CAS.
 * The attempt insert is part of the same statement, so every successful fence
 * has exactly one durable execution record before the caller can do work.
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

/** Reclaims an active run only after its previous owner's lease has expired. */
export async function reclaimRun(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  expectedFence: number,
  owner: string,
): Promise<RunRecord | undefined> {
  return acquireRun(actor, database, runId, expectedFence, owner, "reclaim");
}

async function acquireRun(
  actor: SystemActor,
  database: Queryable,
  runId: string,
  expectedFence: number,
  owner: string,
  mode: "claim" | "reclaim",
): Promise<RunRecord | undefined> {
  const availability =
    mode === "claim"
      ? "status = 'queued' and lease_owner is null and lease_expires_at is null"
      : "status in ('running', 'waiting_approval') and lease_owner is not null and lease_expires_at <= now()";
  const startRun =
    mode === "claim" ? ", status = 'running', started_at = coalesce(started_at, now())" : "";
  const { rows } = await database.query<RunRecord>(
    "with claimed as (" +
      "update run set lease_owner = $4, lease_fence = lease_fence + 1, " +
      `lease_expires_at = now() + make_interval(secs => $5), updated_at = now()${startRun} ` +
      `where id = $1 and space_id = $2 and lease_fence = $3 and ${availability} ` +
      `returning ${runColumns}` +
      "), recorded as (" +
      "insert into attempt (run_id, fence, status) " +
      "select id, \"leaseFence\", 'running'::attempt_status from claimed " +
      "returning run_id" +
      ") select claimed.* from claimed join recorded on recorded.run_id = claimed.id",
    [runId, actor.spaceId, expectedFence, owner, RUN_LEASE_TTL_SECONDS],
  );

  return rows[0];
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
  const transitionGuard = statusTransitionGuard(patch.status);
  const { rows } = await database.query<RunRecord>(
    `update run set ${assignments.join(", ")} ` +
      `where id = $${firstGuard} and space_id = $${firstGuard + 1} ` +
      `and lease_owner = $${firstGuard + 2} and lease_fence = $${firstGuard + 3} ` +
      "and lease_expires_at > now() and status in ('running', 'waiting_approval') " +
      transitionGuard +
      `returning ${runColumns}`,
    values,
  );

  return ownedRow(rows, runId);
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
