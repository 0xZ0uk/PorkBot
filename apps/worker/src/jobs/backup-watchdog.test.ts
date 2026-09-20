import { NotificationEmulator } from "@porkbot/adapters";
import type { BackupRunRecord, BackupStatus, BackupStatusReader, Queryable } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { parseCronItems } from "graphile-worker";
import { JobPayloadError } from "../job-registry.ts";
import type { JobContext } from "../job-registry.ts";
import { backupWatchdogSchedule } from "../worker.ts";
import {
  backupWatchdogIdentifier,
  backupWatchdogJob,
  parseBackupWatchdogPayload,
} from "./backup-watchdog.ts";

/**
 * The backup watchdog's contract, without a queue: the ledger is read once,
 * `@porkbot/core` decides what is alert-worthy, the episode claim keeps one
 * fact to one message, and the delivery rides the notification provider seam.
 * A fake reader and the offline emulator make every branch observable, and the
 * fake client proves the handler checks out a connection and does nothing else
 * with it.
 */

const logger = createLogger({ service: "backup-watchdog-test", level: "error" });
const at = (iso: string): Date => new Date(iso);

function runRecord(overrides: Partial<BackupRunRecord> = {}): BackupRunRecord {
  return {
    id: "run-1",
    status: "succeeded",
    startedAt: at("2026-09-20T03:00:00.000Z"),
    finishedAt: at("2026-09-20T03:04:00.000Z"),
    canaryToken: "11111111-1111-1111-1111-111111111111",
    postgresKey: "backups/postgres/run-1.dump.enc",
    postgresSize: 10,
    postgresChecksum: "abc",
    homesCount: 0,
    homesBytes: 0,
    prunedObjects: 0,
    errorCode: null,
    drillStatus: "succeeded",
    drillStartedAt: at("2026-09-20T03:05:00.000Z"),
    drillFinishedAt: at("2026-09-20T03:06:00.000Z"),
    drillCanaryVerified: true,
    drillErrorCode: null,
    ...overrides,
  };
}

interface FakeReader extends BackupStatusReader {
  readonly claims: readonly { readonly kind: string; readonly episode: string }[];
}

function fakeReader(status: Partial<BackupStatus>, alreadyClaimed = false): FakeReader {
  const claims: { kind: string; episode: string }[] = [];

  return {
    claims,
    async status() {
      return {
        lastRun: status.lastRun,
        lastSuccess: status.lastSuccess,
        lastDrill: status.lastDrill,
        lastDrillRun: status.lastDrillRun,
      };
    },
    async claimAlert(kind, episode) {
      claims.push({ kind, episode });

      return !alreadyClaimed;
    },
  };
}

function context(client: Queryable = { query: async () => ({ rows: [] }) }): JobContext {
  return {
    jobId: "job-1",
    attempt: 1,
    logger,
    withPgClient: async (work) => work(client),
    enqueue: async () => undefined,
  };
}

describe("the backup watchdog payload", () => {
  it("accepts an empty payload and the cron marker", () => {
    expect(parseBackupWatchdogPayload({})).toEqual({});
    expect(parseBackupWatchdogPayload({ _cron: { ts: "x" } })).toEqual({});
  });

  it("refuses work smuggled into the payload", () => {
    expect(() => parseBackupWatchdogPayload({ runId: "run-1" })).toThrow(JobPayloadError);
    expect(() => parseBackupWatchdogPayload("run-1")).toThrow(JobPayloadError);
  });

  it("is scheduled every five minutes under its own identifier", () => {
    expect(backupWatchdogSchedule.task).toBe(backupWatchdogIdentifier);
    expect(backupWatchdogSchedule.match).toBe("*/5 * * * *");
    expect(parseCronItems([backupWatchdogSchedule])).toHaveLength(1);
  });
});

describe("the backup watchdog pass", () => {
  it("delivers nothing when the ledger is fresh", async () => {
    const emulator = new NotificationEmulator();
    const reader = fakeReader({
      lastRun: runRecord(),
      lastSuccess: runRecord(),
      lastDrill: runRecord(),
      lastDrillRun: runRecord(),
    });
    const job = backupWatchdogJob({
      alerts: emulator,
      reader: () => reader,
      now: () => at("2026-09-20T12:00:00.000Z"),
    });

    await job.handle({}, context());

    expect(emulator.size).toBe(0);
    expect(reader.claims).toEqual([]);
  });

  it("announces a failed run once, and a repeat pass announces nothing", async () => {
    const emulator = new NotificationEmulator();
    const failed = runRecord({ status: "failed", finishedAt: at("2026-09-20T03:01:00.000Z") });
    const reader = fakeReader({
      lastRun: failed,
      lastSuccess: runRecord({ finishedAt: at("2026-09-19T03:04:00.000Z") }),
      lastDrill: runRecord(),
      lastDrillRun: runRecord(),
    });
    const job = backupWatchdogJob({
      alerts: emulator,
      reader: () => reader,
      now: () => at("2026-09-20T12:00:00.000Z"),
    });

    await job.handle({}, context());

    expect(emulator.deliveries().map((delivery) => delivery.title)).toEqual([
      "A backup run failed",
    ]);

    const claimedReader = fakeReader(
      {
        lastRun: failed,
        lastSuccess: runRecord({ finishedAt: at("2026-09-19T03:04:00.000Z") }),
        lastDrill: runRecord(),
        lastDrillRun: runRecord(),
      },
      true,
    );
    const repeat = backupWatchdogJob({
      alerts: emulator,
      reader: () => claimedReader,
      now: () => at("2026-09-20T12:05:00.000Z"),
    });

    await repeat.handle({}, context());

    expect(emulator.size).toBe(1);
    expect(claimedReader.claims).toHaveLength(1);
  });

  it("announces a deployment that has never backed up", async () => {
    const emulator = new NotificationEmulator();
    const reader = fakeReader({});
    const job = backupWatchdogJob({
      alerts: emulator,
      reader: () => reader,
      now: () => at("2026-09-20T12:00:00.000Z"),
    });

    await job.handle({}, context());

    expect(emulator.last()?.body).toContain("No backup has ever succeeded");
  });

  it("logs without a provider instead of failing the job", async () => {
    const reader = fakeReader({});
    const job = backupWatchdogJob({
      reader: () => reader,
      now: () => at("2026-09-20T12:00:00.000Z"),
    });

    await expect(job.handle({}, context())).resolves.toBeUndefined();
    expect(reader.claims).toHaveLength(1);
  });
});
