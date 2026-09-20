import { describe, expect, it } from "vitest";
import {
  BACKUP_ALERT_KINDS,
  backupEnvelopeAad,
  backupHomesKey,
  backupPostgresKey,
  backupRunIdFromKey,
  BackupEnvelopeError,
  decideBackupAlerts,
  DEFAULT_BACKUP_SCHEDULE,
  isBackupDue,
  isDrillDue,
  nextBackupAt,
  parseBackupKeyEnvelope,
  selectExpiredBackupKeys,
} from "./backup-policy.ts";
import type { BackupAlertInput, BackupKeyEnvelope } from "./backup-policy.ts";

/**
 * The backup policy's decisions at exact instants. Nothing here sleeps or
 * touches a clock: a schedule question is answered by comparing two `Date`s,
 * which is what makes the 03:00 boundary and the month-long tolerances
 * testable without waiting.
 */

const at = (iso: string): Date => new Date(iso);

function alertInput(overrides: Partial<BackupAlertInput> = {}): BackupAlertInput {
  return {
    now: at("2026-09-20T12:00:00.000Z"),
    lastRun: {
      status: "succeeded",
      startedAt: at("2026-09-20T03:00:00.000Z"),
      finishedAt: at("2026-09-20T03:04:00.000Z"),
    },
    lastSuccessAt: at("2026-09-20T03:04:00.000Z"),
    lastDrillAt: at("2026-09-01T03:10:00.000Z"),
    lastDrillRun: {
      status: "succeeded",
      startedAt: at("2026-09-01T03:05:00.000Z"),
      finishedAt: at("2026-09-01T03:10:00.000Z"),
    },
    ...overrides,
  };
}

describe("the nightly schedule", () => {
  it("defaults to 03:00 UTC", () => {
    expect(DEFAULT_BACKUP_SCHEDULE).toEqual({ hourUtc: 3, minuteUtc: 0 });
  });

  it("finds the next scheduled instant strictly after the cursor", () => {
    expect(
      nextBackupAt(at("2026-09-20T02:59:59.000Z"), DEFAULT_BACKUP_SCHEDULE).toISOString(),
    ).toBe("2026-09-20T03:00:00.000Z");
    expect(
      nextBackupAt(at("2026-09-20T03:00:00.000Z"), DEFAULT_BACKUP_SCHEDULE).toISOString(),
    ).toBe("2026-09-21T03:00:00.000Z");
  });

  it("runs immediately when the ledger has no attempt", () => {
    expect(isBackupDue(at("2026-09-20T12:00:00.000Z"), null)).toBe(true);
  });

  it("is not due twice in one night", () => {
    const lastAttempt = at("2026-09-20T03:00:00.000Z");

    expect(isBackupDue(at("2026-09-20T23:59:59.000Z"), lastAttempt)).toBe(false);
    expect(isBackupDue(at("2026-09-21T03:00:00.000Z"), lastAttempt)).toBe(true);
  });

  it("collapses a multi-day outage into one due run, not a burst", () => {
    const lastAttempt = at("2026-09-16T03:00:00.000Z");
    const now = at("2026-09-20T12:00:00.000Z");

    expect(isBackupDue(now, lastAttempt)).toBe(true);
    // The next cursor is the run that just started, so the same outage does
    // not schedule yesterday's run as well.
    expect(isBackupDue(now, now)).toBe(false);
  });

  it("refuses an impossible schedule or an invalid clock", () => {
    expect(() =>
      nextBackupAt(at("2026-09-20T00:00:00.000Z"), { hourUtc: 24, minuteUtc: 0 }),
    ).toThrow(RangeError);
    expect(() => isBackupDue(new Date("nonsense"), null)).toThrow(RangeError);
  });
});

describe("the restore drill", () => {
  it("is not due before the first backup arms it", () => {
    expect(
      isDrillDue({
        now: at("2026-09-20T12:00:00.000Z"),
        lastDrillAt: null,
        lastBackupAt: null,
      }),
    ).toBe(false);
  });

  it("is due once the interval has elapsed since the last drill", () => {
    expect(
      isDrillDue({
        now: at("2026-09-20T12:00:00.000Z"),
        lastDrillAt: at("2026-08-21T12:00:00.000Z"),
        lastBackupAt: at("2026-09-20T03:04:00.000Z"),
      }),
    ).toBe(true);

    expect(
      isDrillDue({
        now: at("2026-09-20T12:00:00.000Z"),
        lastDrillAt: at("2026-09-10T12:00:00.000Z"),
        lastBackupAt: at("2026-09-20T03:04:00.000Z"),
      }),
    ).toBe(false);
  });

  it("stays due until a drill has succeeded, from the first backup on", () => {
    expect(
      isDrillDue({
        now: at("2026-09-20T12:00:00.000Z"),
        lastDrillAt: null,
        lastBackupAt: at("2026-09-19T03:04:00.000Z"),
      }),
    ).toBe(true);
  });

  it("honours a custom interval and refuses a nonsense one", () => {
    expect(
      isDrillDue({
        now: at("2026-09-20T12:00:00.000Z"),
        lastDrillAt: at("2026-09-18T12:00:00.000Z"),
        lastBackupAt: at("2026-09-19T03:04:00.000Z"),
        intervalDays: 2,
      }),
    ).toBe(true);
    expect(() =>
      isDrillDue({ now: new Date(), lastDrillAt: null, lastBackupAt: new Date(), intervalDays: 0 }),
    ).toThrow(RangeError);
  });
});

describe("retention", () => {
  const objects = [
    {
      key: backupPostgresKey("11111111-1111-1111-1111-111111111111"),
      lastModified: "2026-08-01T03:00:00.000Z",
    },
    {
      key: backupHomesKey("11111111-1111-1111-1111-111111111111", "computer-snapshots/aa/bb.tar"),
      lastModified: "2026-08-01T03:05:00.000Z",
    },
    {
      key: backupPostgresKey("22222222-2222-2222-2222-222222222222"),
      lastModified: "2026-09-19T03:00:00.000Z",
    },
  ];

  it("expires only what is older than the window", () => {
    expect(
      selectExpiredBackupKeys(objects, {
        now: at("2026-09-20T12:00:00.000Z"),
        retentionDays: 30,
      }),
    ).toEqual([objects[0]?.key, objects[1]?.key]);
  });

  it("keeps a protected key even when it is older than the window", () => {
    expect(
      selectExpiredBackupKeys(objects, {
        now: at("2026-09-20T12:00:00.000Z"),
        retentionDays: 1,
        protect: [objects[0]?.key ?? ""],
      }),
    ).toEqual([objects[1]?.key, objects[2]?.key]);
  });

  it("raises on an unparseable listing rather than guessing an age", () => {
    expect(() =>
      selectExpiredBackupKeys([{ key: "backups/x", lastModified: "yesterday" }], {
        now: at("2026-09-20T12:00:00.000Z"),
        retentionDays: 30,
      }),
    ).toThrow(/unparseable/);
  });

  it("refuses a retention window of zero days", () => {
    expect(() => selectExpiredBackupKeys([], { now: new Date(), retentionDays: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("alert decisions", () => {
  it("stays quiet when a fresh success and drill exist", () => {
    expect(decideBackupAlerts(alertInput())).toEqual([]);
  });

  it("announces a failed run once per failed start", () => {
    const alerts = decideBackupAlerts(
      alertInput({
        lastRun: {
          status: "failed",
          startedAt: at("2026-09-20T03:00:00.000Z"),
          finishedAt: at("2026-09-20T03:01:00.000Z"),
        },
        lastSuccessAt: at("2026-09-19T03:04:00.000Z"),
      }),
    );

    expect(alerts).toContainEqual({
      kind: "backup.failed",
      episode: "2026-09-20T03:00:00.000Z",
    });
  });

  it("calls a run still running past its timeout stalled", () => {
    const alerts = decideBackupAlerts(
      alertInput({
        lastRun: {
          status: "running",
          startedAt: at("2026-09-20T04:00:00.000Z"),
          finishedAt: null,
        },
      }),
    );

    expect(alerts).toContainEqual({
      kind: "backup.stalled",
      episode: "2026-09-20T04:00:00.000Z",
    });
  });

  it("does not call a young running row stalled", () => {
    const alerts = decideBackupAlerts(
      alertInput({
        lastRun: {
          status: "running",
          startedAt: at("2026-09-20T11:30:00.000Z"),
          finishedAt: null,
        },
      }),
    );

    expect(alerts).toEqual([]);
  });

  it("announces a backup that has never succeeded, as the never episode", () => {
    const alerts = decideBackupAlerts(
      alertInput({ lastRun: null, lastSuccessAt: null, lastDrillAt: null, lastDrillRun: null }),
    );

    expect(alerts).toContainEqual({ kind: "backup.missed", episode: "never" });
    // No drill alert: a drill with nothing to restore is not due.
    expect(alerts.map((alert) => alert.kind)).not.toContain("drill.missed");
  });

  it("announces a success gap only after the staleness window", () => {
    const fresh = decideBackupAlerts(alertInput({ lastSuccessAt: at("2026-09-19T10:00:00.000Z") }));

    expect(fresh.map((alert) => alert.kind)).not.toContain("backup.missed");

    const stale = decideBackupAlerts(
      alertInput({
        lastSuccessAt: at("2026-09-18T10:00:00.000Z"),
        lastRun: {
          status: "running",
          startedAt: at("2026-09-20T11:30:00.000Z"),
          finishedAt: null,
        },
      }),
    );

    expect(stale).toContainEqual({
      kind: "backup.missed",
      episode: "2026-09-18T10:00:00.000Z",
    });
  });

  it("announces a drill that failed or that has gone stale", () => {
    const failed = decideBackupAlerts(
      alertInput({
        lastDrillRun: {
          status: "failed",
          startedAt: at("2026-09-15T03:05:00.000Z"),
          finishedAt: at("2026-09-15T03:06:00.000Z"),
        },
      }),
    );

    expect(failed).toContainEqual({ kind: "drill.failed", episode: "2026-09-15T03:05:00.000Z" });

    const stale = decideBackupAlerts(alertInput({ lastDrillAt: at("2026-06-01T03:10:00.000Z") }));

    expect(stale).toContainEqual({ kind: "drill.missed", episode: "2026-06-01T03:10:00.000Z" });
  });

  it("keeps the alert vocabulary closed and exhaustive", () => {
    const seen = new Set<string>();
    const cases: BackupAlertInput[] = [
      alertInput({
        lastRun: { status: "failed", startedAt: at("2026-09-20T03:00:00.000Z"), finishedAt: null },
      }),
      alertInput({
        lastRun: { status: "running", startedAt: at("2026-09-20T00:00:00.000Z"), finishedAt: null },
      }),
      alertInput({ lastSuccessAt: null, lastRun: null }),
      alertInput({
        lastDrillRun: {
          status: "failed",
          startedAt: at("2026-09-15T03:05:00.000Z"),
          finishedAt: null,
        },
      }),
      alertInput({ lastDrillAt: at("2026-06-01T03:10:00.000Z") }),
    ];

    for (const input of cases) {
      for (const alert of decideBackupAlerts(input)) {
        seen.add(alert.kind);
      }
    }

    expect([...seen].sort()).toEqual([...BACKUP_ALERT_KINDS].sort());
  });
});

describe("backup object keys", () => {
  it("addresses a run's dump and a source object's copy", () => {
    const runId = "11111111-2222-3333-4444-555555555555";

    expect(backupPostgresKey(runId)).toBe(`backups/postgres/${runId}.dump.enc`);
    expect(backupHomesKey(runId, "computer-snapshots/aa/bb.tar")).toBe(
      `backups/homes/${runId}/computer-snapshots/aa/bb.tar.enc`,
    );
    expect(backupRunIdFromKey(backupPostgresKey(runId))).toBe(runId);
    expect(backupRunIdFromKey(backupHomesKey(runId, "computer-snapshots/aa/bb.tar"))).toBe(runId);
    expect(backupRunIdFromKey("computer-snapshots/aa/bb.tar")).toBeUndefined();
  });
});

describe("the key envelope shape", () => {
  const valid: BackupKeyEnvelope = {
    version: "v1",
    kdf: { name: "scrypt", salt: "c2FsdA", n: 32768, r: 8, p: 1, keyLength: 32 },
    cipher: "aes-256-gcm",
    iv: "aXZpdg",
    authTag: "dGFn",
    ciphertext: "Y2lwaGVy",
  };

  it("accepts the shape it writes", () => {
    expect(parseBackupKeyEnvelope(valid)).toEqual(valid);
  });

  it("refuses an unknown version, KDF or cipher", () => {
    expect(() => parseBackupKeyEnvelope({ ...valid, version: "v2" })).toThrow(BackupEnvelopeError);
    expect(() =>
      parseBackupKeyEnvelope({ ...valid, kdf: { ...valid.kdf, name: "pbkdf2" } }),
    ).toThrow(BackupEnvelopeError);
    expect(() => parseBackupKeyEnvelope({ ...valid, cipher: "aes-128-gcm" })).toThrow(
      BackupEnvelopeError,
    );
  });

  it("refuses a downgraded key length or a non-base64url field", () => {
    expect(() =>
      parseBackupKeyEnvelope({ ...valid, kdf: { ...valid.kdf, keyLength: 16 } }),
    ).toThrow(BackupEnvelopeError);
    expect(() => parseBackupKeyEnvelope({ ...valid, iv: "not base64!" })).toThrow(
      BackupEnvelopeError,
    );
    expect(() => parseBackupKeyEnvelope("v1")).toThrow(BackupEnvelopeError);
  });

  it("authenticates everything but the ciphertext, with stable text", () => {
    const aad = backupEnvelopeAad(valid);

    expect(aad).toContain('"n":32768');
    expect(aad).not.toContain(valid.ciphertext);
    expect(backupEnvelopeAad(valid)).toBe(aad);
    expect(backupEnvelopeAad({ ...valid, kdf: { ...valid.kdf, n: 16384 } })).not.toBe(aad);
  });
});
