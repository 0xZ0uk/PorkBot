/**
 * The backup process's entry module.
 *
 * `moduleInfo` names the process for the health probe and the log lines, the
 * same shape every app uses. The re-exports are the seams the unit and
 * integration suites build directly — the cipher, the archive, the run, the
 * scheduler and the configuration — so a test exercises the shipped code
 * rather than a parallel copy of it.
 */
export const moduleInfo = {
  name: "@porkbot/backup",
  summary:
    "Nightly encrypted Postgres and bot-home backups, with a scheduled restore drill and a sealed key envelope.",
} as const;

export { createBackupArchive, type BackupArchive, type StoredBackupObject } from "./archive.ts";
export {
  backupKeyringFromEnvironment,
  decryptBackupStream,
  encryptBackupStream,
  keyringKeyIds,
  openKeyEnvelope,
  sealKeyEnvelope,
} from "./cipher.ts";
export {
  defaultBackupDirectory,
  defaultEnvelopeDirectory,
  defaultTickMs,
  envelopeFileName,
  loadBackupConfig,
  loadBackupKeys,
  loadBackupPaths,
  type BackupConfig,
  type BackupKeys,
  type BackupPaths,
} from "./config.ts";
export { performRestoreDrill, restoreBackupInto, type RestoreOutcome } from "./drill.ts";
export { readKeyEnvelopeFile, writeKeyEnvelope } from "./envelope.ts";
export {
  backupErrorDetail,
  BackupError,
  BACKUP_ERROR_CODES,
  classifyBackupError,
  type BackupErrorCode,
} from "./errors.ts";
export {
  createPostgresTools,
  databaseUrl,
  scratchDatabaseName,
  type PostgresTools,
} from "./postgres.ts";
export {
  homesPrefix,
  latestPostgresObject,
  performBackupRun,
  type BackupRunDependencies,
} from "./run.ts";
export { createBackupScheduler, type BackupScheduler } from "./scheduler.ts";
