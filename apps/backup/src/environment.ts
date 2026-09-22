/**
 * The one place this process reads `process.env` (slice 12.3).
 *
 * The `env` CI tier's `varlock audit` compares `apps/backup/.env.schema`
 * against the code that reads it, so the reads are literal and complete here:
 * a variable the code reads but the schema does not declare, and a declared
 * variable no code reads, both fail the tier by name. Everything else in the
 * app takes a plain record as an argument, which is also what makes the
 * configuration testable without touching the process environment.
 */
export interface BackupEnvironment extends Readonly<Record<string, string | undefined>> {
  readonly DATABASE_URL: string | undefined;
  readonly PORKBOT_STORAGE_DIR: string | undefined;
  readonly PORKBOT_BACKUP_DIR: string | undefined;
  readonly PORKBOT_BACKUP_ENVELOPE_DIR: string | undefined;
  readonly PORKBOT_BACKUP_KEYS: string | undefined;
  readonly PORKBOT_BACKUP_ACTIVE_KEY: string | undefined;
  readonly PORKBOT_BACKUP_ENVELOPE_PASSPHRASE: string | undefined;
  readonly PORKBOT_BACKUP_SCHEDULE_HOUR_UTC: string | undefined;
  readonly PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC: string | undefined;
  readonly PORKBOT_BACKUP_RETENTION_DAYS: string | undefined;
  readonly PORKBOT_BACKUP_DRILL_INTERVAL_DAYS: string | undefined;
  readonly PORKBOT_BACKUP_S3_ENDPOINT: string | undefined;
  readonly PORKBOT_BACKUP_S3_BUCKET: string | undefined;
  readonly PORKBOT_BACKUP_S3_REGION: string | undefined;
  readonly PORKBOT_BACKUP_S3_ACCESS_KEY_ID: string | undefined;
  readonly PORKBOT_BACKUP_S3_SECRET_ACCESS_KEY: string | undefined;
}

export function readBackupEnvironment(): BackupEnvironment {
  return {
    DATABASE_URL: process.env["DATABASE_URL"],
    PORKBOT_STORAGE_DIR: process.env["PORKBOT_STORAGE_DIR"],
    PORKBOT_BACKUP_DIR: process.env["PORKBOT_BACKUP_DIR"],
    PORKBOT_BACKUP_ENVELOPE_DIR: process.env["PORKBOT_BACKUP_ENVELOPE_DIR"],
    PORKBOT_BACKUP_KEYS: process.env["PORKBOT_BACKUP_KEYS"],
    PORKBOT_BACKUP_ACTIVE_KEY: process.env["PORKBOT_BACKUP_ACTIVE_KEY"],
    PORKBOT_BACKUP_ENVELOPE_PASSPHRASE: process.env["PORKBOT_BACKUP_ENVELOPE_PASSPHRASE"],
    PORKBOT_BACKUP_SCHEDULE_HOUR_UTC: process.env["PORKBOT_BACKUP_SCHEDULE_HOUR_UTC"],
    PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC: process.env["PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC"],
    PORKBOT_BACKUP_RETENTION_DAYS: process.env["PORKBOT_BACKUP_RETENTION_DAYS"],
    PORKBOT_BACKUP_DRILL_INTERVAL_DAYS: process.env["PORKBOT_BACKUP_DRILL_INTERVAL_DAYS"],
    PORKBOT_BACKUP_S3_ENDPOINT: process.env["PORKBOT_BACKUP_S3_ENDPOINT"],
    PORKBOT_BACKUP_S3_BUCKET: process.env["PORKBOT_BACKUP_S3_BUCKET"],
    PORKBOT_BACKUP_S3_REGION: process.env["PORKBOT_BACKUP_S3_REGION"],
    PORKBOT_BACKUP_S3_ACCESS_KEY_ID: process.env["PORKBOT_BACKUP_S3_ACCESS_KEY_ID"],
    PORKBOT_BACKUP_S3_SECRET_ACCESS_KEY: process.env["PORKBOT_BACKUP_S3_SECRET_ACCESS_KEY"],
  };
}
