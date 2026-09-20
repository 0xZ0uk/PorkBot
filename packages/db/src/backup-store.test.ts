import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Queryable } from "./queryable.ts";
import { createBackupLedger, createBackupStatusReader, readCanaryToken } from "./backup-store.ts";
import type { BackupRunRecord } from "./backup-store.ts";

/**
 * The backup ledger without a server: a recording fake stands in for the pg
 * client, so these tests prove the module's own contract — a run opens
 * `running` and settles in one statement, the canary rewrite is a single
 * delete-and-insert CTE, a drill may only follow a succeeded run, and the
 * episode claim answers true only for the caller that moved the episode.
 * Postgres owns the checks, the enum and the singleton index; the integration
 * suite runs the same seams against the real server.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
}

function fakeDatabase(respond: (call: QueryCall) => readonly unknown[] = () => []): FakeDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      const call = { text, values };
      calls.push(call);

      return { rows: respond(call) as readonly Row[] };
    },
  };
}

/** A raw row as the driver hands it back: bigints as strings. */
function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    status: "running",
    startedAt: new Date("2026-09-20T03:00:00.000Z"),
    finishedAt: null,
    canaryToken: "11111111-1111-1111-1111-111111111111",
    postgresKey: null,
    postgresSize: null,
    postgresChecksum: null,
    homesCount: 0,
    homesBytes: "0",
    prunedObjects: 0,
    errorCode: null,
    drillStatus: null,
    drillStartedAt: null,
    drillFinishedAt: null,
    drillCanaryVerified: false,
    drillErrorCode: null,
    ...overrides,
  };
}

const succeeded: BackupRunRecord = {
  id: "run-1",
  status: "succeeded",
  startedAt: new Date("2026-09-20T03:00:00.000Z"),
  finishedAt: new Date("2026-09-20T03:04:00.000Z"),
  canaryToken: "11111111-1111-1111-1111-111111111111",
  postgresKey: "backups/postgres/run-1.dump.enc",
  postgresSize: 4096,
  postgresChecksum: "abc",
  homesCount: 2,
  homesBytes: 8192,
  prunedObjects: 1,
  errorCode: null,
  drillStatus: "succeeded",
  drillStartedAt: new Date("2026-09-20T03:05:00.000Z"),
  drillFinishedAt: new Date("2026-09-20T03:06:00.000Z"),
  drillCanaryVerified: true,
  drillErrorCode: null,
};

describe("opening and settling a run", () => {
  it("opens a run with the canary token and parses the row the driver returns", async () => {
    const database = fakeDatabase(() => [rawRow({ postgresSize: "4096", homesBytes: "8192" })]);
    const ledger = createBackupLedger(database);

    const run = await ledger.beginRun({ canaryToken: "11111111-1111-1111-1111-111111111111" });

    expect(database.calls[0]?.text).toContain("insert into backup_run");
    expect(database.calls[0]?.values).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(run.postgresSize).toBe(4096);
    expect(run.homesBytes).toBe(8192);
  });

  it("settles a run in one statement, clearing the error code on success", async () => {
    const database = fakeDatabase(() => [rawRow({ status: "succeeded" })]);
    const ledger = createBackupLedger(database);

    await ledger.settleRun("run-1", {
      status: "succeeded",
      postgresKey: "backups/postgres/run-1.dump.enc",
      postgresSize: 4096,
      postgresChecksum: "abc",
      homesCount: 2,
      homesBytes: 8192,
      prunedObjects: 3,
    });

    const call = database.calls[0];

    expect(call?.text).toContain("update backup_run set");
    expect(call?.text).toContain("finished_at = now()");
    expect(call?.text).toContain("error_code = $8");
    expect(call?.values?.at(-1)).toBe("run-1");
  });

  it("fails loudly when the insert returned no row", async () => {
    const ledger = createBackupLedger(fakeDatabase());

    await expect(ledger.beginRun({ canaryToken: randomUUID() })).rejects.toThrow(/no row/);
  });

  it("refuses to settle a run that is not there", async () => {
    const ledger = createBackupLedger(fakeDatabase());

    await expect(ledger.settleRun("missing", { status: "failed" })).rejects.toThrow(/disappeared/);
  });

  it("rewrites the canary as one upsert on the singleton index", async () => {
    const database = fakeDatabase();
    const ledger = createBackupLedger(database);

    await ledger.writeCanary("22222222-2222-2222-2222-222222222222");

    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.text).toContain("insert into backup_canary");
    expect(database.calls[0]?.text).toContain("on conflict (singleton) do update");
  });
});

describe("the drill half of a run", () => {
  it("opens a drill only on a succeeded run", async () => {
    const database = fakeDatabase(() => [rawRow({ drillStatus: "running" })]);
    const ledger = createBackupLedger(database);

    await ledger.beginDrill("run-1");

    expect(database.calls[0]?.text).toContain("status = 'succeeded'");
    expect(database.calls[0]?.text).toContain("drill_status = 'running'");
  });

  it("refuses to drill a run that is not succeeded", async () => {
    const ledger = createBackupLedger(fakeDatabase());

    await expect(ledger.beginDrill("run-1")).rejects.toThrow(/nothing to drill/);
  });

  it("settles a running drill with the canary verdict", async () => {
    const database = fakeDatabase(() => [
      rawRow({ drillStatus: "succeeded", drillCanaryVerified: true }),
    ]);
    const ledger = createBackupLedger(database);

    const run = await ledger.settleDrill("run-1", { status: "succeeded", canaryVerified: true });

    expect(database.calls[0]?.text).toContain("drill_status = 'running'");
    expect(database.calls[0]?.values).toEqual(["run-1", "succeeded", true, null]);
    expect(run.drillCanaryVerified).toBe(true);
  });

  it("refuses to settle a drill that is not running", async () => {
    const ledger = createBackupLedger(fakeDatabase());

    await expect(
      ledger.settleDrill("run-1", { status: "failed", canaryVerified: false }),
    ).rejects.toThrow(/not running/);
  });
});

describe("the watchdog's read half", () => {
  it("answers the newest run, success, drill and drill attempt", async () => {
    const database = fakeDatabase((call) => {
      if (call.text.includes("where status = 'succeeded'")) {
        return [rawRow({ id: "run-success", status: "succeeded" })];
      }

      if (call.text.includes("where drill_status = 'succeeded'")) {
        return [rawRow({ id: "drill-success", drillStatus: "succeeded" })];
      }

      if (call.text.includes("where drill_status is not null")) {
        return [rawRow({ id: "drill-last", drillStatus: "failed" })];
      }

      return [rawRow({ id: "run-last", status: "failed" })];
    });
    const reader = createBackupStatusReader(database);

    const status = await reader.status();

    expect(status.lastRun?.id).toBe("run-last");
    expect(status.lastSuccess?.id).toBe("run-success");
    expect(status.lastDrill?.id).toBe("drill-success");
    expect(status.lastDrillRun?.id).toBe("drill-last");
    expect(database.calls).toHaveLength(4);
  });

  it("answers undefined for an empty ledger rather than inventing a run", async () => {
    const reader = createBackupStatusReader(fakeDatabase());

    const status = await reader.status();

    expect(status.lastRun).toBeUndefined();
    expect(status.lastSuccess).toBeUndefined();
    expect(status.lastDrill).toBeUndefined();
    expect(status.lastDrillRun).toBeUndefined();
  });

  it("claims an episode only when the upsert returned a row", async () => {
    const claimingDatabase = fakeDatabase(() => [{ id: "alert-1" }]);
    const claimed = createBackupStatusReader(claimingDatabase);
    const repeated = createBackupStatusReader(fakeDatabase());

    expect(await claimed.claimAlert("backup.missed", "never")).toBe(true);
    expect(await repeated.claimAlert("backup.missed", "never")).toBe(false);

    const call = claimingDatabase.calls[0];

    expect(call?.text).toContain("on conflict (kind) do update");
    expect(call?.text).toContain("where backup_alert.episode is distinct from excluded.episode");
  });
});

describe("the canary read", () => {
  it("answers the newest token", async () => {
    const database = fakeDatabase(() => [{ token: "22222222-2222-2222-2222-222222222222" }]);

    await expect(readCanaryToken(database)).resolves.toBe("22222222-2222-2222-2222-222222222222");
    expect(database.calls[0]?.text).toContain("order by written_at desc");
  });

  it("answers null for a database with no canary row", async () => {
    await expect(readCanaryToken(fakeDatabase())).resolves.toBeNull();
  });
});

describe("the records the ledger returns", () => {
  it("keeps a settled run's shape", () => {
    expect(succeeded.postgresSize).toBe(4096);
    expect(succeeded.drillCanaryVerified).toBe(true);
  });
});
