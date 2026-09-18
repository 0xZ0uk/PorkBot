import { quoteIdentifier } from "./queryable.ts";
import type { Queryable } from "./queryable.ts";

/**
 * Reading drizzle's ledger, in one place.
 *
 * The migrator records every applied entry in `drizzle.__drizzle_migrations`;
 * counting those rows before and after a run is what turns "apply the journal"
 * into the report `pnpm db:migrate` prints, and what lets the integration suite
 * assert that a second run applied nothing. The ledger schema and table are
 * Postgres identifiers, never user input, and the connection string is never
 * logged: the command reports counts, not the URL.
 *
 * `runMigrations` itself lives in `run-migrations.ts`, because it needs a live
 * connection and the unit tier measures what it can run without a server.
 */

export const migrationsSchema = "drizzle";
export const migrationsTable = "__drizzle_migrations";

export interface MigrationRunOptions {
  /** Defaults to this package's `migrations/` directory. */
  readonly migrationsFolder?: string;
}

export interface MigrationRunReport {
  readonly folder: string;
  /** Migrations this run applied; zero means the database was already current. */
  readonly applied: number;
  /** Total migrations recorded in the ledger after this run. */
  readonly total: number;
}

/** Rows in drizzle's ledger, or zero when the ledger table does not exist yet. */
export async function countAppliedMigrations(database: Queryable): Promise<number> {
  const ledger = `${migrationsSchema}.${migrationsTable}`;
  const { rows: present } = await database.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [ledger],
  );

  if (present[0]?.present !== true) {
    return 0;
  }

  const { rows } = await database.query<{ count: number }>(
    `select count(*)::int as count from ${quoteIdentifier(migrationsSchema)}.${quoteIdentifier(migrationsTable)}`,
  );

  return rows[0]?.count ?? 0;
}

export function formatMigrationReport(report: MigrationRunReport): string {
  if (report.applied === 0) {
    return `up to date: ${report.total} migration(s) already applied`;
  }

  return `applied ${report.applied} migration(s), ${report.total} total`;
}
