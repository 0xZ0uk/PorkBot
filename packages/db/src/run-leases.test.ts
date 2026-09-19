import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LeaseLostError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import type { RunRecord } from "./records.ts";
import { createRepositories } from "./repositories.ts";
import {
  expiredLeaseReason,
  findExpiredLeases,
  RUN_HEARTBEAT_GRACE_SECONDS,
  RUN_HEARTBEAT_INTERVAL_SECONDS,
  RUN_LEASE_TTL_SECONDS,
  RUN_WATCHDOG_BATCH_LIMIT,
} from "./run-leases.ts";

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function fakeDatabase(rows: readonly RunRecord[] = []): Queryable & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query<Row>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      return { rows: rows as readonly Row[] };
    },
  };
}

const actor: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };
const run: RunRecord = {
  id: "run-1",
  spaceId: actor.spaceId,
  botId: "bot-1",
  threadId: "thread-1",
  taskId: "task-1",
  userId: "user-1",
  status: "running",
  trigger: "message",
  error: null,
  errorCode: null,
  leaseOwner: "worker-a",
  leaseFence: 1,
  leaseExpiresAt: new Date(120_000),
  stopRequestedAt: null,
  checkpoint: {},
  clientNonce: "nonce-1",
  sourceMessageId: "message-1",
  startedAt: new Date(0),
  completedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("run leases", () => {
  it("documents a grace period in the lease TTL", () => {
    expect(RUN_HEARTBEAT_INTERVAL_SECONDS).toBeGreaterThan(0);
    expect(RUN_HEARTBEAT_GRACE_SECONDS).toBeGreaterThan(0);
    expect(RUN_LEASE_TTL_SECONDS).toBe(
      RUN_HEARTBEAT_INTERVAL_SECONDS + RUN_HEARTBEAT_GRACE_SECONDS,
    );
  });

  it("guards claim and reclaim on status, owner state, space, and the expected fence", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);
    const reason = "the lease expired at 12:00 and no heartbeat renewed it";

    await repositories.runs.claim(run.id, 0, "worker-a");
    await repositories.runs.reclaim(run.id, 1, "worker-b", { reason });

    const claim = database.calls[0];
    expect(claim?.text).toContain("status = 'queued'");
    expect(claim?.text).toContain("lease_owner is null");
    expect(claim?.text).toContain("lease_fence = $3");
    expect(claim?.text).toContain("insert into attempt");
    expect(claim?.values).toEqual([run.id, actor.spaceId, 0, "worker-a", 120]);

    const reclaim = database.calls[1];
    expect(reclaim?.text).toContain("status in ('running', 'waiting_approval')");
    expect(reclaim?.text).toContain("lease_owner is not null");
    expect(reclaim?.text).toContain("lease_expires_at <= now()");
    expect(reclaim?.values).toEqual([run.id, actor.spaceId, 1, "worker-b", 120, reason]);
  });

  it("records why a reclaim superseded its predecessor and settles what was in flight", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);
    const reason = "the lease expired at 12:00";

    await repositories.runs.reclaim(run.id, 1, "worker-b", { reason });

    const reclaim = database.calls[0];
    expect(reclaim?.text).toContain("update attempt set status = 'abandoned'");
    expect(reclaim?.text).toContain("error = $6");
    expect(reclaim?.text).toContain("update external_effect set status = 'failed'");
    expect(reclaim?.text).toContain("jsonb_build_object('error', $6::text)");
    expect(reclaim?.text).toContain("status in ('pending', 'running')");
    // The reconciliation rides the same statement as the lease CAS.
    expect(reclaim?.text.match(/with claimed as/g)).toHaveLength(1);
    expect(reclaim?.text).toContain("exists (select 1 from claimed)");
  });

  it("lets a watchdog reclaim without recording an attempt it never executed", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);
    const reason = "the lease expired at 12:00";

    await repositories.runs.reclaim(run.id, 1, "watchdog-job", {
      reason,
      recordAttempt: false,
    });

    const reclaim = database.calls[0];
    expect(reclaim?.text).not.toContain("insert into attempt");
    expect(reclaim?.text).toContain("update attempt set status = 'abandoned'");
    expect(reclaim?.text).toContain("update external_effect set status = 'failed'");
    expect(reclaim?.values).toEqual([run.id, actor.spaceId, 1, "watchdog-job", 120, reason]);
    expect(reclaim?.text).toContain("select claimed.* from claimed");
  });

  it("hands a live lease from its exact owner to the adopter", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);

    await repositories.runs.adopt(run.id, 2, "worker-b", "watchdog-job");

    const adopt = database.calls[0];
    expect(adopt?.text).toContain("lease_owner = $6");
    expect(adopt?.text).toContain("lease_expires_at > now()");
    expect(adopt?.text).toContain("insert into attempt");
    expect(adopt?.values).toEqual([run.id, actor.spaceId, 2, "worker-b", 120, "watchdog-job"]);
  });

  it("guards heartbeats and all run patches on owner, fence, expiry, and space", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);
    const lease = { owner: "worker-a", fence: 1 };

    await repositories.runs.heartbeat(run.id, lease);
    await repositories.runs.update(run.id, lease, {
      status: "completed",
      checkpoint: { step: 2 },
      completed: true,
      attempt: "completed",
    });

    for (const call of database.calls) {
      expect(call.text).toContain("space_id");
      expect(call.text).toContain("lease_owner");
      expect(call.text).toContain("lease_fence");
      expect(call.text).toContain("lease_expires_at > now()");
      expect(call.values).toContain(actor.spaceId);
      expect(call.values).toContain(lease.owner);
      expect(call.values).toContain(lease.fence);
    }
    expect(database.calls[1]?.text).toContain("status in ('running', 'waiting_approval')");
    expect(database.calls[1]?.text).toContain("and status = 'running'");
  });

  it("settles the attempt for the same fence whenever a patch asks for it", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);
    const lease = { owner: "worker-a", fence: 1 };

    await repositories.runs.update(run.id, lease, {
      status: "failed",
      error: "the tool call failed",
      attempt: "failed",
    });
    await repositories.runs.update(run.id, lease, { checkpoint: { step: 2 } });

    const settled = database.calls[0];
    expect(settled?.text).toContain("settled as (");
    expect(settled?.text).toContain("status = $7::attempt_status");
    expect(settled?.text).toContain("error = $8");
    expect(settled?.text).toContain("fence = $6 and status = 'running'");
    expect(settled?.text).toContain("exists (select 1 from updated)");
    expect(settled?.values).toEqual([
      "failed",
      "the tool call failed",
      run.id,
      actor.spaceId,
      "worker-a",
      1,
      "failed",
      "the tool call failed",
    ]);

    // A checkpoint-only patch settles nothing; the attempt keeps running.
    expect(database.calls[1]?.text).not.toContain("settled as (");
  });

  it("settles the run's in-flight calls in the same write when a cancellation asks for it", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);
    const lease = { owner: "worker-a", fence: 1 };

    await repositories.runs.update(run.id, lease, {
      status: "cancelled",
      completed: true,
      attempt: "cancelled",
      release: true,
      settleInFlight: "the run was cancelled before this tool call settled",
    });
    await repositories.runs.update(run.id, lease, {
      status: "completed",
      completed: true,
      attempt: "completed",
      release: true,
    });

    const cancelled = database.calls[0];
    expect(cancelled?.text).toContain("reconciled as (");
    expect(cancelled?.text).toContain(
      "update external_effect set status = 'failed'::effect_status",
    );
    expect(cancelled?.text).toContain("status in ('pending', 'running')");
    expect(cancelled?.text).toContain("exists (select 1 from updated)");
    expect(cancelled?.values).toContain("the run was cancelled before this tool call settled");

    // A completion carries no reason: a session that completed with an open
    // call is a bug, not a reconciliation.
    expect(database.calls[1]?.text).not.toContain("reconciled as (");
  });

  it("maps every run status onto its allowed pre-image and stamps started_at", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);
    const lease = { owner: "worker-a", fence: 1 };

    await repositories.runs.update(run.id, lease, { status: "running" });
    await repositories.runs.update(run.id, lease, { status: "waiting_approval" });
    await repositories.runs.update(run.id, lease, { status: "failed" });
    await repositories.runs.update(run.id, lease, { status: "cancelled" });
    await repositories.runs.update(run.id, lease, { status: "queued" });
    await repositories.runs.update(run.id, lease, { started: true });

    expect(database.calls[0]?.text).toContain("and status = 'waiting_approval' ");
    expect(database.calls[1]?.text).toContain("and status = 'running' ");
    expect(database.calls[2]?.text).toContain("and status in ('running', 'waiting_approval') ");
    expect(database.calls[3]?.text).toContain("and status in ('running', 'waiting_approval') ");
    expect(database.calls[4]?.text).toContain("and false ");
    expect(database.calls[5]?.text).toContain("started_at = coalesce(started_at, now())");
  });

  it("reports a stale heartbeat or write as typed lease loss", async () => {
    const repositories = createRepositories(actor, fakeDatabase());
    const lease = { owner: "worker-a", fence: 1 };

    await expect(repositories.runs.heartbeat(run.id, lease)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      repositories.runs.update(run.id, lease, { checkpoint: {} }),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("closes only this fence's running attempt, inside the run's space", async () => {
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);

    const closed = await repositories.runs.abandonAttempt(run.id, 1, "the lease was lost");

    expect(closed).toBe(true);
    const call = database.calls[0];
    expect(call?.text).toContain("update attempt set status = 'abandoned'");
    expect(call?.text).toContain("fence = $2 and status = 'running'");
    expect(call?.text).toContain("r.space_id = $3");
    expect(call?.values).toEqual([run.id, 1, actor.spaceId, "the lease was lost"]);
  });

  it("builds the reclaim reason from the expired timestamp", () => {
    const expiredAt = new Date("2026-09-18T12:00:00.000Z");

    expect(expiredLeaseReason(expiredAt)).toContain("2026-09-18T12:00:00.000Z");
    expect(expiredLeaseReason(null)).toContain("expired");
  });

  it("keeps lease-column writes in the lease module", () => {
    const workspace = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
    const roots = [join(workspace, "apps"), join(workspace, "packages")];
    const writers = roots
      .flatMap((root) => sourceFiles(root))
      .filter((name) => {
        const text = readFileSync(name, "utf8");
        return /update run set[^;]*(lease_owner|lease_fence|lease_expires_at)\s*=/s.test(text);
      })
      .map((name) => name.slice(workspace.length + 1));

    expect(writers).toEqual(["packages/db/src/run-leases.ts"]);
  });
});

describe("the watchdog's expired-lease scan", () => {
  it("reads active runs past their expiry, oldest first, and never a checkpoint", async () => {
    const database = fakeDatabase([]);

    await findExpiredLeases(database);

    const scan = database.calls[0];
    expect(scan?.text).toContain("status in ('running', 'waiting_approval')");
    expect(scan?.text).toContain("lease_owner is not null");
    expect(scan?.text).toContain("lease_expires_at <= now()");
    expect(scan?.text).toContain("order by lease_expires_at asc, id asc");
    expect(scan?.text).not.toContain("checkpoint");
    expect(scan?.text).not.toContain("space_id = ");
    expect(scan?.values).toEqual([RUN_WATCHDOG_BATCH_LIMIT]);
  });

  it("takes a batch limit so one pass cannot hold a job open forever", async () => {
    const database = fakeDatabase([]);

    await findExpiredLeases(database, 7);

    expect(database.calls[0]?.values).toEqual([7]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name === "test") {
        return [];
      }

      return sourceFiles(path);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}
