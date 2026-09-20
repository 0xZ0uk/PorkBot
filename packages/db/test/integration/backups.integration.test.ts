import { randomBytes, randomUUID } from "node:crypto";
import { createSuiteDatabase, connectToSuite } from "@porkbot/testkit";
import type { SuiteClient, SuiteDatabase } from "@porkbot/testkit";
import { afterAll, describe, expect, it } from "vitest";
import { createBackupLedger, createBackupStatusReader } from "../../src/backup-store.ts";
import type { Queryable } from "../../src/queryable.ts";

/**
 * The backup ledger against the real server (slice 12.3).
 *
 * The unit suite proves the statements' shape over a fake; this one proves the
 * schema's own answers: the enum, the settled-row checks, the canary's
 * singleton index, the `on conflict` episode claim and the reads the worker's
 * watchdog makes. The suite database is a clone of the migrated template, so
 * the tables are the ones a deployment gets.
 */

let suite: SuiteDatabase | undefined;
let client: SuiteClient | undefined;

function database(): Queryable {
  if (client === undefined) {
    throw new Error("the suite client was not connected");
  }

  return client;
}

afterAll(async () => {
  try {
    await client?.end();
  } finally {
    await suite?.destroy();
  }
});

describe("the backup ledger", () => {
  it("opens, canaries, settles and drills one run", async () => {
    suite = await createSuiteDatabase({
      suite: `backup_ledger_${randomBytes(3).toString("hex")}`,
    });
    client = await connectToSuite(suite);

    const ledger = createBackupLedger(database());
    const canaryToken = randomUUID();
    const run = await ledger.beginRun({ canaryToken });

    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();

    await ledger.writeCanary(canaryToken);

    const { rows: canary } = await database().query<{ token: string }>(
      "select token::text as token from backup_canary",
    );

    expect(canary).toHaveLength(1);
    expect(canary[0]?.token).toBe(canaryToken);

    const settled = await ledger.settleRun(run.id, {
      status: "succeeded",
      postgresKey: `backups/postgres/${run.id}.dump.enc`,
      postgresSize: 4096,
      postgresChecksum: "abc",
      homesCount: 1,
      homesBytes: 512,
    });

    expect(settled.status).toBe("succeeded");
    expect(settled.finishedAt).not.toBeNull();

    const drilling = await ledger.beginDrill(run.id);

    expect(drilling.drillStatus).toBe("running");

    const drilled = await ledger.settleDrill(run.id, { status: "succeeded", canaryVerified: true });

    expect(drilled.drillStatus).toBe("succeeded");
    expect(drilled.drillCanaryVerified).toBe(true);

    const reader = createBackupStatusReader(database());
    const status = await reader.status();

    expect(status.lastRun?.id).toBe(run.id);
    expect(status.lastSuccess?.id).toBe(run.id);
    expect(status.lastDrill?.id).toBe(run.id);
    expect(status.lastDrillRun?.id).toBe(run.id);
  });

  it("keeps the canary to one row and refuses a second drill settlement", async () => {
    const ledger = createBackupLedger(database());
    const run = await ledger.beginRun({ canaryToken: randomUUID() });

    await ledger.writeCanary(randomUUID());
    await ledger.writeCanary(randomUUID());

    const { rows } = await database().query<{ count: string }>(
      "select count(*)::text as count from backup_canary",
    );

    expect(rows[0]?.count).toBe("1");

    await ledger.settleRun(run.id, { status: "failed", errorCode: "dump_failed" });

    await expect(ledger.beginDrill(run.id)).rejects.toThrow(/nothing to drill/);
  });

  it("refuses a settled row whose finish and status disagree", async () => {
    const run = await createBackupLedger(database()).beginRun({ canaryToken: randomUUID() });

    await expect(
      database().query("update backup_run set status = 'succeeded' where id = $1", [run.id]),
    ).rejects.toThrow(/backup_run_settled_check/);
  });

  it("claims one alert episode once, and a new episode again", async () => {
    const reader = createBackupStatusReader(database());

    expect(await reader.claimAlert("backup.missed", "never")).toBe(true);
    expect(await reader.claimAlert("backup.missed", "never")).toBe(false);
    expect(await reader.claimAlert("backup.missed", "2026-09-20T03:00:00.000Z")).toBe(true);
    expect(await reader.claimAlert("backup.missed", "2026-09-20T03:00:00.000Z")).toBe(false);
  });
});
