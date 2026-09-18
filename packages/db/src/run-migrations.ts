import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { countAppliedMigrations, migrationsSchema, migrationsTable } from "./migrate.ts";
import type { MigrationRunOptions, MigrationRunReport } from "./migrate.ts";
import { migrationsDirectory } from "./migrations/files.ts";

/**
 * The database-bound half of `pnpm db:migrate`, kept apart from the counting
 * and formatting so the unit tier can measure those without a server. The
 * integration tier runs this through the real command: the journal is applied
 * once, recorded in drizzle's ledger, and the second run is a no-op.
 */
export async function runMigrations(
  pool: Pool,
  options: MigrationRunOptions = {},
): Promise<MigrationRunReport> {
  const folder = options.migrationsFolder ?? migrationsDirectory();
  const before = await countAppliedMigrations(pool);

  await migrate(drizzle(pool), {
    migrationsFolder: folder,
    migrationsSchema,
    migrationsTable,
  });

  const after = await countAppliedMigrations(pool);

  return { folder, applied: after - before, total: after };
}
