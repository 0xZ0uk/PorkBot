import { randomUUID } from "node:crypto";
import type { StorageObject, StorageProvider } from "@porkbot/adapter-kit";
import {
  BACKUP_OBJECT_PREFIX,
  backupHomesKey,
  backupPostgresKey,
  isDrillDue,
  selectExpiredBackupKeys,
} from "@porkbot/core";
import type { BackupLedger, BackupRunRecord, BackupStatus } from "@porkbot/db";
import type { Logger } from "@porkbot/logging";
import type { BackupArchive } from "./archive.ts";
import { performRestoreDrill } from "./drill.ts";
import type { CanaryReader } from "./drill.ts";
import { BackupError, backupErrorDetail, classifyBackupError } from "./errors.ts";
import type { PostgresTools } from "./postgres.ts";

/**
 * One nightly run (slice 12.3; PRD story 5).
 *
 * The order is the point. A run writes its canary first, then takes the dump,
 * then copies the homes, then prunes, then settles the row, then drills — so
 * the ledger never claims a success that did not happen, and the drill always
 * restores a dump whose row already records the canary it must contain.
 *
 * Every failure settles the row `failed` with a closed `error_code` and is
 * returned rather than thrown: the scheduler's next tick must be able to run,
 * and the operator's signal is the ledger plus the worker's watchdog, not a
 * crashed process. Only a failure to write the ledger itself escapes, because
 * then there is no record to settle.
 *
 * Homes are read through the storage seam, never a filesystem path. The
 * snapshot archives under `computer-snapshots/` are the durable copy of every
 * computer's home — a Docker volume, a cloud sandbox or the supervisor's
 * delegate all reach the seam through the snapshot path — so copying them into
 * the backup destination is what makes a remote computer's home recoverable.
 * A provider whose home story is "not backed up" (the offline emulator)
 * simply has no archive under that prefix; `COMPUTER_HOME_SYNC` in
 * `@porkbot/adapter-kit` states that per provider.
 */

/** The prefix the computer snapshot store writes homes under. */
export const homesPrefix = "computer-snapshots/";

export interface BackupRunDependencies {
  readonly ledger: BackupLedger;
  readonly archive: BackupArchive;
  /** The primary storage the homes are read from; not the backup destination. */
  readonly homes: StorageProvider;
  readonly postgres: PostgresTools;
  readonly connectionString: string;
  readonly logger: Logger;
  /** How many days a backup object stays readable. */
  readonly retentionDays: number;
  /** Days between restore drills. */
  readonly drillIntervalDays: number;
  readonly now: () => Date;
  /** The canary read the drill performs; defaults to the store. */
  readonly readCanary?: CanaryReader | undefined;
}

interface CopiedHomes {
  readonly count: number;
  readonly bytes: number;
  readonly keys: readonly string[];
}

async function copyHomes(dependencies: BackupRunDependencies, runId: string): Promise<CopiedHomes> {
  const objects = await dependencies.homes.list(homesPrefix);
  const keys: string[] = [];
  let count = 0;
  let bytes = 0;

  for (const object of objects) {
    const found = await dependencies.homes.get(object.key);

    // An object deleted between the listing and the read is not a failure:
    // the snapshot it named is gone, and a backup of a deleted home is not a
    // thing to invent.
    if (found === undefined) {
      dependencies.logger.info("a home snapshot disappeared before it was copied", {
        key: object.key,
      });
      continue;
    }

    const stored = await dependencies.archive.put(
      backupHomesKey(runId, object.key),
      found.body,
      object.contentType,
    );

    keys.push(stored.key);
    count += 1;
    bytes += stored.size;
  }

  return { count, bytes, keys };
}

async function prune(
  dependencies: BackupRunDependencies,
  protect: readonly string[],
): Promise<number> {
  const objects = await dependencies.archive.list(`${BACKUP_OBJECT_PREFIX}/`);
  const expired = selectExpiredBackupKeys(objects, {
    now: dependencies.now(),
    retentionDays: dependencies.retentionDays,
    protect,
  });

  if (expired.length === 0) {
    return 0;
  }

  try {
    const removed = await dependencies.archive.remove(expired);

    dependencies.logger.info("retention pruned expired backup objects", { removed });

    return removed;
  } catch (error) {
    throw new BackupError(
      "retention_failed",
      "the retention pass could not delete expired objects",
      {
        cause: error,
      },
    );
  }
}

async function drillIfDue(
  dependencies: BackupRunDependencies,
  settled: BackupRunRecord,
  previous: BackupStatus,
): Promise<BackupRunRecord | undefined> {
  const lastDrillAt = previous.lastDrill?.drillFinishedAt ?? null;
  const due = isDrillDue({
    now: dependencies.now(),
    lastDrillAt,
    lastBackupAt: settled.finishedAt,
    intervalDays: dependencies.drillIntervalDays,
  });

  if (!due) {
    return undefined;
  }

  const drilled = await dependencies.ledger.beginDrill(settled.id);

  try {
    const outcome = await performRestoreDrill(
      {
        postgres: dependencies.postgres,
        archive: dependencies.archive,
        connectionString: dependencies.connectionString,
        readCanary: dependencies.readCanary,
        logger: dependencies.logger,
      },
      drilled,
    );

    const settledDrill = await dependencies.ledger.settleDrill(settled.id, {
      status: "succeeded",
      canaryVerified: true,
    });

    dependencies.logger.info("restore drill succeeded", {
      runId: settled.id,
      tables: outcome.tables,
    });

    return settledDrill;
  } catch (error) {
    const code = classifyBackupError(error);
    const failedDrill = await dependencies.ledger.settleDrill(settled.id, {
      status: "failed",
      canaryVerified: false,
      errorCode: code,
    });

    dependencies.logger.error("restore drill failed", {
      runId: settled.id,
      code,
      detail: backupErrorDetail(error),
    });

    return failedDrill;
  }
}

/**
 * Runs one backup and, when the schedule says so, its restore drill. The
 * returned row is the settled run; the drill's outcome, when one ran, is on
 * the same row's drill columns.
 */
export async function performBackupRun(
  dependencies: BackupRunDependencies,
  previous: BackupStatus,
): Promise<BackupRunRecord> {
  const canaryToken = randomUUID();
  const run = await dependencies.ledger.beginRun({ canaryToken });

  dependencies.logger.info("backup run started", { runId: run.id });

  try {
    await dependencies.ledger.writeCanary(canaryToken);

    const dump = await dependencies.postgres.dump(dependencies.connectionString, (body) =>
      dependencies.archive.put(backupPostgresKey(run.id), body, "application/octet-stream"),
    );

    const homes = await copyHomes(dependencies, run.id);
    const pruned = await prune(dependencies, [dump.key, ...homes.keys]);

    const settled = await dependencies.ledger.settleRun(run.id, {
      status: "succeeded",
      postgresKey: dump.key,
      postgresSize: dump.size,
      postgresChecksum: dump.checksum,
      homesCount: homes.count,
      homesBytes: homes.bytes,
      prunedObjects: pruned,
    });

    dependencies.logger.info("backup run succeeded", {
      runId: settled.id,
      dumpBytes: dump.size,
      homes: homes.count,
      pruned,
    });

    // The returned row carries the drill's outcome too, so an operator's `run`
    // command and a test both see the whole attempt in one answer.
    return (await drillIfDue(dependencies, settled, previous)) ?? settled;
  } catch (error) {
    const code = classifyBackupError(error);

    dependencies.logger.error("backup run failed", {
      runId: run.id,
      code,
      detail: backupErrorDetail(error),
    });

    return await dependencies.ledger.settleRun(run.id, { status: "failed", errorCode: code });
  }
}

/** The newest Postgres object the destination holds, for a recovery by hand. */
export async function latestPostgresObject(
  archive: BackupArchive,
): Promise<StorageObject | undefined> {
  const objects = await archive.list(`${BACKUP_OBJECT_PREFIX}/postgres/`);

  return [...objects].sort((left, right) => right.lastModified.localeCompare(left.lastModified))[0];
}
