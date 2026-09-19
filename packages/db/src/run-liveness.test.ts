import { describe, expect, it } from "vitest";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import type { RunRecord } from "./records.ts";
import { createRepositories } from "./repositories.ts";
import { claimRunNotification, findStalledRuns, markRunStalled } from "./run-liveness.ts";

/**
 * Run-stall detection (slice 6.10): the cross-space scan returns addressing
 * only, and the scoped mark re-checks every fact that made the run a candidate
 * so two detectors race to one episode. The SQL is pinned here; Postgres proves
 * the predicates in the integration suite.
 */

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

describe("the stalled-run scan", () => {
  it("reads live leased runs with stale progress, without naming a space or a checkpoint", async () => {
    const database = fakeDatabase([]);

    await findStalledRuns(database, 180, 7);

    const scan = database.calls[0];
    expect(scan?.text).toContain("status = 'running'");
    expect(scan?.text).toContain("lease_owner is not null");
    expect(scan?.text).toContain("lease_expires_at > now()");
    expect(scan?.text).toContain("stop_requested_at is null");
    expect(scan?.text).toContain("stalled_at is null");
    expect(scan?.text).toContain("current_step is distinct from 'waiting'");
    expect(scan?.text).toContain("last_progress_at is not null");
    expect(scan?.text).toContain("last_progress_at < now() - make_interval(secs => $1)");
    expect(scan?.text).toContain("order by last_progress_at asc, id asc");
    expect(scan?.text).not.toContain("checkpoint");
    expect(scan?.text).not.toContain("space_id = ");
    expect(scan?.values).toEqual([180, 7]);

    // Addressing only: the caller re-reads the row through its own scope.
    expect(scan?.text).toContain('id as "runId"');
    expect(scan?.text).toContain('space_id as "spaceId"');
  });
});

describe("marking a stall episode", () => {
  it("re-checks liveness, stop, lease and episode in the scoped write", async () => {
    const run = { id: "run-1", spaceId: actor.spaceId } as RunRecord;
    const database = fakeDatabase([run]);

    const marked = await markRunStalled(actor, database, "run-1", 180);

    expect(marked).toBe(run);
    const call = database.calls[0];
    expect(call?.text).toContain("stalled_at = now()");
    expect(call?.text).toContain("where id = $1 and space_id = $2");
    expect(call?.text).toContain("status = 'running'");
    expect(call?.text).toContain("lease_owner is not null and lease_expires_at > now()");
    expect(call?.text).toContain("stop_requested_at is null and stalled_at is null");
    expect(call?.text).toContain("current_step is distinct from 'waiting'");
    expect(call?.text).toContain("last_progress_at is not null");
    expect(call?.text).toContain("last_progress_at < now() - make_interval(secs => $3)");
    expect(call?.values).toEqual(["run-1", actor.spaceId, 180]);
  });

  it("answers undefined when another detector already marked the episode", async () => {
    const database = fakeDatabase([]);

    expect(await markRunStalled(actor, database, "run-1", 180)).toBeUndefined();
  });

  it("is reachable through the system actor's run writer", async () => {
    const run = { id: "run-1", spaceId: actor.spaceId } as RunRecord;
    const database = fakeDatabase([run]);
    const repositories = createRepositories(actor, database);

    const marked = await repositories.runs.markStalled("run-1", 180);

    expect(marked).toBe(run);
    expect(database.calls[0]?.text).toContain("stalled_at = now()");
  });
});

describe("claiming the terminal notification", () => {
  it("sets the claim in one scoped guarded write", async () => {
    const database = fakeDatabase([{ id: "run-1" } as RunRecord]);

    const claimed = await claimRunNotification(actor, database, "run-1");

    expect(claimed).toBe(true);
    const call = database.calls[0];
    expect(call?.text).toContain("notified_at = now()");
    expect(call?.text).toContain("where id = $1 and space_id = $2");
    expect(call?.text).toContain("notified_at is null");
    // A cancelled run is the operator's own act: the guard never claims it.
    expect(call?.text).toContain("status in ('completed', 'failed')");
    expect(call?.values).toEqual(["run-1", actor.spaceId]);
  });

  it("answers false when the claim was already taken or the run is not terminal", async () => {
    const database = fakeDatabase([]);

    expect(await claimRunNotification(actor, database, "run-1")).toBe(false);
  });

  it("is reachable through the system actor's run writer", async () => {
    const database = fakeDatabase([{ id: "run-1" } as RunRecord]);
    const repositories = createRepositories(actor, database);

    expect(await repositories.runs.claimNotification("run-1")).toBe(true);
    expect(database.calls[0]?.text).toContain("notified_at = now()");
  });
});
