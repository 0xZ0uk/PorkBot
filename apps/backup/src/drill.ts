import { randomBytes } from "node:crypto";
import type { Logger } from "@porkbot/logging";
import { openDatabase, queryable, readCanaryToken } from "@porkbot/db";
import type { BackupRunRecord } from "@porkbot/db";
import type { BackupArchive } from "./archive.ts";
import { BackupError } from "./errors.ts";
import type { PostgresTools } from "./postgres.ts";
import { databaseUrl, scratchDatabaseName } from "./postgres.ts";

/**
 * The restore path (slice 12.3; PRD story 5).
 *
 * One function restores an object into a named database, and the scheduled
 * drill and the operator's recovery command are the same code with different
 * questions afterwards. The drill compares the canary token it reads back with
 * the one the run recorded and drops the scratch database; recovery keeps the
 * database it restored and reports what is readable. Neither trusts the
 * restore's exit code alone: a database that `pg_restore` filled with zero
 * tables is not a restored product.
 *
 * The caller owns the database's lifetime, and a failed restore drops what it
 * created before the error surfaces: a half-restored database is a trap that
 * looks like a product and is not one. The drill drops its scratch database on
 * success too, so a drill leaves the server as it found it; recovery keeps the
 * database it restored, because keeping it is the point.
 */

/**
 * How the restored database's canary is read. The default goes through the
 * backup store's module — the one place that names the row — over a fresh
 * connection to the restored database; a suite injects its own so the drill
 * can be exercised without a second server.
 */
export interface CanaryReader {
  read(databaseUrl: string): Promise<string | null>;
}

const defaultCanaryReader: CanaryReader = {
  async read(databaseUrl: string): Promise<string | null> {
    const handle = openDatabase(databaseUrl);

    try {
      return await readCanaryToken(queryable(handle));
    } finally {
      await handle.close();
    }
  },
};

export interface RestoreDependencies {
  readonly postgres: PostgresTools;
  readonly archive: BackupArchive;
  /** The connection the backup runs over; its server hosts the restored database. */
  readonly connectionString: string;
  readonly logger: Logger;
  /** The canary read; defaults to the store over the restored database. */
  readonly readCanary?: CanaryReader | undefined;
}

export interface RestoreOutcome {
  /** The canary token the restored database holds, when one is readable. */
  readonly canaryToken: string | null;
  /** How many tables the restored database's `public` schema has. */
  readonly tables: number;
}

const tablesQuery =
  "select count(*)::int as tables from information_schema.tables where table_schema = 'public'";

export interface RestoreRequest {
  readonly objectKey: string;
  /** The database to create and restore into; it must not already exist. */
  readonly database: string;
  readonly expected?: { readonly size: number; readonly checksum: string } | undefined;
}

/**
 * Creates `database`, restores `objectKey` into it, and answers what is
 * readable. The database is created by this call, so an existing name is a
 * refusal rather than an overwrite: recovery never clobbers a database that
 * might be the one it was supposed to replace. The caller drops the database
 * when it wants to (the drill does; recovery does not).
 */
export async function restoreBackupInto(
  dependencies: RestoreDependencies,
  request: RestoreRequest,
): Promise<RestoreOutcome> {
  const { postgres, archive, connectionString, logger } = dependencies;

  try {
    await postgres.createDatabase(connectionString, request.database);
  } catch (error) {
    throw new BackupError(
      "scratch_database_failed",
      `could not create the restore database "${request.database}"`,
      { cause: error },
    );
  }

  const restoredUrl = databaseUrl(connectionString, request.database);

  try {
    const found = await archive.read(request.objectKey, request.expected);

    if (found === undefined) {
      throw new BackupError("restore_failed", `no backup object exists at "${request.objectKey}"`);
    }

    await postgres.restore(restoredUrl, found.body);

    const tableRows = await postgres.query<{ tables: number }>(restoredUrl, tablesQuery);
    const tables = tableRows[0]?.tables ?? 0;

    if (tables === 0) {
      throw new BackupError("restore_failed", "the restored database has no tables");
    }

    // The canary read goes through the store's module, which is the one place
    // that names the row — even here, where the row lives in the restored
    // database rather than in the ledger.
    const canaryToken = await (dependencies.readCanary ?? defaultCanaryReader).read(restoredUrl);

    logger.info("the restored database answered a read", {
      database: request.database,
      tables,
      canary: canaryToken === null ? "absent" : "present",
    });

    return { canaryToken, tables };
  } catch (error) {
    // A half-restored database is a trap: it looks like a product and is not
    // one. A failed restore removes what it created before the caller hears
    // why; a successful one is the caller's to keep or drop.
    await postgres.dropDatabase(connectionString, request.database).catch(() => undefined);

    throw error;
  }
}

export type DrillDependencies = RestoreDependencies;

/**
 * The scheduled drill: restore the run's dump into a scratch database and
 * prove the canary came back. A missing canary row, a token that differs from
 * the one the run wrote, and a database with no tables are all the drill's
 * failure — the restore produced something other than the data that was
 * backed up.
 */
export async function performRestoreDrill(
  dependencies: DrillDependencies,
  run: BackupRunRecord,
): Promise<RestoreOutcome> {
  if (run.postgresKey === null || run.postgresSize === null || run.postgresChecksum === null) {
    throw new BackupError("restore_failed", "the run has no stored dump to drill");
  }

  const database = scratchDatabaseName(randomBytes(4).toString("hex"));

  try {
    const outcome = await restoreBackupInto(dependencies, {
      objectKey: run.postgresKey,
      database,
      expected: { size: run.postgresSize, checksum: run.postgresChecksum },
    });

    if (outcome.canaryToken === null) {
      throw new BackupError("canary_mismatch", "the restored database has no canary row");
    }

    if (outcome.canaryToken !== run.canaryToken) {
      throw new BackupError(
        "canary_mismatch",
        "the restored canary token is not the token this run wrote",
      );
    }

    return outcome;
  } finally {
    try {
      await dependencies.postgres.dropDatabase(dependencies.connectionString, database);
    } catch (error) {
      // A leftover scratch database is named, so an operator can drop it; the
      // drill's own answer is what the caller needs.
      dependencies.logger.warn("could not drop the drill's scratch database", {
        database,
        error: error instanceof Error ? error.name : "unknown error",
      });
    }
  }
}
