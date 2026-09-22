import path from "node:path";
import {
  createEnvironmentCredentialStore,
  LocalStorageProvider,
  S3CompatibleStorageProvider,
} from "@porkbot/adapters";
import type { StorageProvider } from "@porkbot/adapter-kit";
import { DEFAULT_BACKUP_SCHEDULE } from "@porkbot/core";
import type { NightlyBackupSchedule } from "@porkbot/core";
import type { CredentialKeyring } from "@porkbot/db";
import type { Logger } from "@porkbot/logging";
import { backupKeyringFromEnvironment } from "./cipher.ts";
import { BackupError } from "./errors.ts";

/**
 * The backup job's configuration (slice 12.3).
 *
 * Everything the process needs is read once here and validated before a run
 * starts: a missing keyring, a half-configured S3 target, a non-numeric
 * retention window or a passphrase-less envelope all fail boot with a sentence
 * naming the variable. That is the same direction the other entrypoints take —
 * a process that boots and then cannot back anything up has already failed
 * silently.
 *
 * The split between `loadBackupPaths` and `loadBackupKeys` exists for the one
 * caller that must work without the environment keyring: `restore`, the
 * recovery command, opens the sealed envelope instead. The loop and the `run`
 * command require both.
 *
 * The destination is the one place a deployment chooses local or S3-compatible,
 * and the homes source is always the primary storage root: the same seam the
 * API and the supervisor write through. Credentials for S3 resolve by name
 * through the environment credential store on every request, never from a
 * constructor argument or a log.
 */

export interface BackupPaths {
  readonly connectionString: string;
  readonly storageRoot: string;
  /** The local destination root; ignored when an S3 target is configured. */
  readonly backupDirectory: string;
  /** Where the sealed key envelope is written, deliberately off the target. */
  readonly envelopeDirectory: string;
  readonly envelopePath: string;
  readonly schedule: NightlyBackupSchedule;
  readonly retentionDays: number;
  readonly drillIntervalDays: number;
  /** The backup destination: local directory or S3-compatible bucket. */
  readonly destination: StorageProvider;
  /** The primary storage the homes are read from. */
  readonly homes: StorageProvider;
}

export interface BackupKeys {
  readonly keyring: CredentialKeyring;
  readonly envelopePassphrase: string;
}

export interface BackupConfig extends BackupPaths, BackupKeys {}

export const defaultBackupDirectory = "/var/lib/porkbot/backups";
export const defaultEnvelopeDirectory = "/var/lib/porkbot/backup-envelope";
export const envelopeFileName = "key-envelope.json";

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();

  if (value === undefined || value === "") {
    throw new BackupError("config_invalid", `${name} is not set; the backup job cannot run`);
  }

  return value;
}

function wholeNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();

  if (raw === undefined || raw === "") {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number, received ${JSON.stringify(raw)}`);
  }

  const value = Number(raw);

  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}, received ${value}`);
  }

  return value;
}

function optional(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();

  return value === undefined || value === "" ? undefined : value;
}

/**
 * The S3-compatible target, all-or-none. A deployment that names an endpoint
 * but no bucket has not chosen a destination, and a half-configured target is
 * exactly the kind of silence the acceptance criteria refuse.
 */
function s3Destination(
  env: Readonly<Record<string, string | undefined>>,
  logger: Logger,
): StorageProvider | undefined {
  const names = [
    "PORKBOT_BACKUP_S3_ENDPOINT",
    "PORKBOT_BACKUP_S3_BUCKET",
    "PORKBOT_BACKUP_S3_ACCESS_KEY_ID",
    "PORKBOT_BACKUP_S3_SECRET_ACCESS_KEY",
  ] as const;
  const configured = names.filter((name) => optional(env, name) !== undefined);

  if (configured.length === 0) {
    return undefined;
  }

  if (configured.length !== names.length) {
    const missing = names.filter((name) => optional(env, name) === undefined);

    throw new Error(
      `the S3-compatible backup target is half configured; missing ${missing.join(", ")}`,
    );
  }

  logger.info("backing up to an S3-compatible target", {});

  return new S3CompatibleStorageProvider({
    endpoint: required(env, "PORKBOT_BACKUP_S3_ENDPOINT"),
    bucket: required(env, "PORKBOT_BACKUP_S3_BUCKET"),
    region: optional(env, "PORKBOT_BACKUP_S3_REGION") ?? "us-east-1",
    credentials: createEnvironmentCredentialStore(env),
    accessKeyIdCredentialName: "PORKBOT_BACKUP_S3_ACCESS_KEY_ID",
    secretAccessKeyCredentialName: "PORKBOT_BACKUP_S3_SECRET_ACCESS_KEY",
  });
}

/** Everything a run needs except the keys; `restore` works with only these. */
export function loadBackupPaths(
  env: Readonly<Record<string, string | undefined>>,
  logger: Logger,
): BackupPaths {
  const connectionString = required(env, "DATABASE_URL");
  const storageRoot = required(env, "PORKBOT_STORAGE_DIR");
  const backupDirectory = optional(env, "PORKBOT_BACKUP_DIR") ?? defaultBackupDirectory;
  const envelopeDirectory =
    optional(env, "PORKBOT_BACKUP_ENVELOPE_DIR") ?? defaultEnvelopeDirectory;

  return {
    connectionString,
    storageRoot,
    backupDirectory,
    envelopeDirectory,
    envelopePath: path.join(envelopeDirectory, envelopeFileName),
    schedule: {
      hourUtc: wholeNumber(
        env,
        "PORKBOT_BACKUP_SCHEDULE_HOUR_UTC",
        DEFAULT_BACKUP_SCHEDULE.hourUtc,
        0,
        23,
      ),
      minuteUtc: wholeNumber(
        env,
        "PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC",
        DEFAULT_BACKUP_SCHEDULE.minuteUtc,
        0,
        59,
      ),
    },
    retentionDays: wholeNumber(env, "PORKBOT_BACKUP_RETENTION_DAYS", 30, 1, 3650),
    drillIntervalDays: wholeNumber(env, "PORKBOT_BACKUP_DRILL_INTERVAL_DAYS", 30, 1, 3650),
    destination: s3Destination(env, logger) ?? new LocalStorageProvider({ root: backupDirectory }),
    homes: new LocalStorageProvider({ root: storageRoot }),
  };
}

/** The keyring and its envelope passphrase; required by the loop and `run`. */
export function loadBackupKeys(env: Readonly<Record<string, string | undefined>>): BackupKeys {
  return {
    keyring: backupKeyringFromEnvironment(env),
    envelopePassphrase: required(env, "PORKBOT_BACKUP_ENVELOPE_PASSPHRASE"),
  };
}

export function loadBackupConfig(
  env: Readonly<Record<string, string | undefined>>,
  logger: Logger,
): BackupConfig {
  return { ...loadBackupPaths(env, logger), ...loadBackupKeys(env) };
}
