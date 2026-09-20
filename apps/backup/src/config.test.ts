import { LocalStorageProvider } from "@porkbot/adapters";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { loadBackupConfig, loadBackupKeys, loadBackupPaths } from "./config.ts";
import { BackupError } from "./errors.ts";

/**
 * The configuration's rules, without a process: every missing or contradictory
 * value fails by name, the S3 target is all-or-none, and the local destination
 * is the default so a self-hosted deployment needs no vendor at all. The
 * keyring in these fixtures is invented bytes.
 */

const logger = createLogger({ service: "backup-test", level: "error" });
const key = Buffer.alloc(32, 0x33).toString("base64");
const base = {
  DATABASE_URL: "postgres://porkbot:secret@postgres:5432/porkbot",
  PORKBOT_STORAGE_DIR: "/var/lib/porkbot/storage",
  PORKBOT_BACKUP_KEYS: `k1:${key}`,
  PORKBOT_BACKUP_ACTIVE_KEY: "k1",
  PORKBOT_BACKUP_ENVELOPE_PASSPHRASE: "a generated passphrase",
};

describe("loading the backup configuration", () => {
  it("reads the paths and defaults to a local destination", () => {
    const paths = loadBackupPaths(base, logger);

    expect(paths.destination).toBeInstanceOf(LocalStorageProvider);
    expect(paths.homes).toBeInstanceOf(LocalStorageProvider);
    expect(paths.envelopePath).toBe("/var/lib/porkbot/backup-envelope/key-envelope.json");
    expect(paths.schedule).toEqual({ hourUtc: 3, minuteUtc: 0 });
    // The key that opens the backups is never written under the backup
    // destination: the two are separate volumes in both compose files.
    expect(paths.envelopePath.startsWith(paths.backupDirectory)).toBe(false);
    expect(paths.retentionDays).toBe(30);
    expect(paths.drillIntervalDays).toBe(30);
  });

  it("fails by name for every required value", () => {
    for (const name of [
      "DATABASE_URL",
      "PORKBOT_STORAGE_DIR",
      "PORKBOT_BACKUP_ENVELOPE_PASSPHRASE",
    ]) {
      expect(() => loadBackupConfig({ ...base, [name]: "" }, logger)).toThrow(name);
    }

    expect(() => loadBackupKeys({ ...base, PORKBOT_BACKUP_KEYS: "" })).toThrow(BackupError);
  });

  it("refuses a half-configured S3 target instead of backing up nowhere", () => {
    expect(() =>
      loadBackupPaths({ ...base, PORKBOT_BACKUP_S3_ENDPOINT: "https://s3.example.com" }, logger),
    ).toThrow(/half configured/);
  });

  it("builds an S3 target when all of its settings are present", () => {
    const paths = loadBackupPaths(
      {
        ...base,
        PORKBOT_BACKUP_S3_ENDPOINT: "https://s3.example.com",
        PORKBOT_BACKUP_S3_BUCKET: "porkbot-backups",
        PORKBOT_BACKUP_S3_ACCESS_KEY_ID: "an-access-key",
        PORKBOT_BACKUP_S3_SECRET_ACCESS_KEY: "a-secret-key",
      },
      logger,
    );

    expect(paths.destination).not.toBeInstanceOf(LocalStorageProvider);
  });

  it("refuses numbers outside their range and non-numbers", () => {
    expect(() => loadBackupPaths({ ...base, PORKBOT_BACKUP_RETENTION_DAYS: "0" }, logger)).toThrow(
      /between/,
    );
    expect(() =>
      loadBackupPaths({ ...base, PORKBOT_BACKUP_SCHEDULE_HOUR_UTC: "24" }, logger),
    ).toThrow(/between/);
    expect(() =>
      loadBackupPaths({ ...base, PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC: "soon" }, logger),
    ).toThrow(/whole number/);
  });
});
