import { randomUUID } from "node:crypto";
import type { BackupRunRecord, BackupStatus, BackupStatusReader } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createBackupScheduler } from "./scheduler.ts";

/**
 * The loop's decision, without a clock: the ledger's newest attempt is the
 * cursor, so a fresh ledger runs immediately, a run five minutes old does not,
 * and an operator's `run` command runs whatever the ledger says.
 */

const logger = createLogger({ service: "backup-test", level: "error" });
const at = (iso: string): Date => new Date(iso);

function run(overrides: Partial<BackupRunRecord> = {}): BackupRunRecord {
  return {
    id: randomUUID(),
    status: "succeeded",
    startedAt: at("2026-09-20T03:00:00.000Z"),
    finishedAt: at("2026-09-20T03:04:00.000Z"),
    canaryToken: randomUUID(),
    postgresKey: null,
    postgresSize: null,
    postgresChecksum: null,
    homesCount: 0,
    homesBytes: 0,
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

function reader(status: BackupStatus): BackupStatusReader {
  return {
    async status() {
      return status;
    },
    async claimAlert() {
      return true;
    },
  };
}

function scheduler(lastRun: BackupRunRecord | undefined, nowIso: string) {
  const ran: BackupStatus[] = [];
  const instance = createBackupScheduler({
    reader: reader({
      lastRun,
      lastSuccess: lastRun,
      lastDrill: undefined,
      lastDrillRun: undefined,
    }),
    run: async (previous) => {
      ran.push(previous);
    },
    logger,
    now: () => at(nowIso),
  });

  return { instance, ran };
}

describe("the backup scheduler", () => {
  it("runs immediately when the ledger has no attempt", async () => {
    const { instance, ran } = scheduler(undefined, "2026-09-20T12:00:00.000Z");

    await expect(instance.tick()).resolves.toBe("ran");
    expect(ran).toHaveLength(1);
  });

  it("skips a second run the same night", async () => {
    const { instance, ran } = scheduler(run(), "2026-09-20T23:00:00.000Z");

    await expect(instance.tick()).resolves.toBe("skipped");
    expect(ran).toEqual([]);
  });

  it("runs the next night, and after a multi-day gap", async () => {
    const next = scheduler(run(), "2026-09-21T03:00:00.000Z");
    const afterGap = scheduler(
      run({ startedAt: at("2026-09-16T03:00:00.000Z") }),
      "2026-09-20T12:00:00.000Z",
    );

    await expect(next.instance.tick()).resolves.toBe("ran");
    await expect(afterGap.instance.tick()).resolves.toBe("ran");
  });

  it("runs when the operator forces it, whatever the clock says", async () => {
    const { instance, ran } = scheduler(run(), "2026-09-20T04:00:00.000Z");

    await expect(instance.tick({ force: true })).resolves.toBe("ran");
    expect(ran).toHaveLength(1);
  });
});
