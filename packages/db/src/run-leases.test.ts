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
  RUN_HEARTBEAT_GRACE_SECONDS,
  RUN_HEARTBEAT_INTERVAL_SECONDS,
  RUN_LEASE_TTL_SECONDS,
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

    await repositories.runs.claim(run.id, 0, "worker-a");
    await repositories.runs.reclaim(run.id, 1, "worker-b");

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
    expect(reclaim?.values).toEqual([run.id, actor.spaceId, 1, "worker-b", 120]);
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

  it("reports a stale heartbeat or write as typed lease loss", async () => {
    const repositories = createRepositories(actor, fakeDatabase());
    const lease = { owner: "worker-a", fence: 1 };

    await expect(repositories.runs.heartbeat(run.id, lease)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      repositories.runs.update(run.id, lease, { checkpoint: {} }),
    ).rejects.toBeInstanceOf(LeaseLostError);
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
