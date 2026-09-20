import { isProviderFailure } from "@porkbot/adapter-kit";

/**
 * The backup process's closed failure vocabulary (slice 12.3).
 *
 * A run records one `error_code`; a notification or an operator's `status`
 * read names the same word. Free text from `pg_dump`, the filesystem or a
 * provider never becomes that word — `classifyBackupError` is the one mapping
 * from an arbitrary throw to the code, and everything it does not recognize is
 * `internal_error`, which is a bug to investigate rather than a fact about the
 * deployment. The provider vocabulary is the adapter-kit one, so a storage
 * refusal keeps the kind the storage adapter classified.
 */

export const BACKUP_ERROR_CODES = [
  /** `pg_dump` refused or failed; the dump is not trustworthy. */
  "dump_failed",
  /** `pg_restore` refused or failed; the scratch database is discarded. */
  "restore_failed",
  /** The scratch database could not be created or dropped. */
  "scratch_database_failed",
  /** The restored data did not read back as the backup that was taken. */
  "canary_mismatch",
  /** A storage operation failed: the object could not be written or read. */
  "storage_failed",
  /** The ciphertext did not authenticate: tampered, truncated or wrong key. */
  "cipher_failed",
  /** The sealed key envelope could not be written or opened. */
  "envelope_failed",
  /** The process's configuration is missing or contradictory. */
  "config_invalid",
  /** The retention pass failed; old objects were not pruned. */
  "retention_failed",
  /** Anything the code above does not recognize. */
  "internal_error",
] as const;

export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupError";
    this.code = code;
  }
}

/**
 * The one mapping from a throw to a code. A `BackupError` keeps its own code;
 * a storage or provider failure is `storage_failed` (its kind was already
 * classified inside the adapter); anything else is `internal_error`.
 */
export function classifyBackupError(error: unknown): BackupErrorCode {
  if (error instanceof BackupError) {
    return error.code;
  }

  if (isProviderFailure(error)) {
    return "storage_failed";
  }

  return "internal_error";
}

/** A short, public-safe sentence for the log line; never the raw error text. */
export function backupErrorDetail(error: unknown): string {
  if (error instanceof BackupError) {
    return error.message;
  }

  if (isProviderFailure(error)) {
    return `${error.kind}${error.detail === undefined ? "" : `: ${error.detail}`}`;
  }

  return error instanceof Error ? error.name : "unknown error";
}
