import process from "node:process";
import { Pool } from "pg";
import { formatMigrationReport } from "./migrate.ts";
import { readRolePasswords, setRolePasswords } from "./roles.ts";
import { runMigrations } from "./run-migrations.ts";

/**
 * `pnpm db:migrate`: apply `packages/db/migrations` to `DATABASE_URL`.
 *
 * The command is safe to run twice and safe to run from cron: drizzle's ledger
 * decides what is pending, so the second run applies nothing and exits zero.
 * The connection string is read from the environment and never printed; a
 * failure reports the error's message, which carries the host and role but not
 * the password.
 *
 * Migrations create the two service roles; this command then sets their
 * passwords from `PORKBOT_API_DB_PASSWORD` and `PORKBOT_WORKER_DB_PASSWORD`
 * when they are present. The credential is never in the committed SQL and the
 * report says nothing about it — not even whether one was set.
 *
 * Node 24 runs this TypeScript file directly (type stripping), so the command
 * works from a clean checkout after `pnpm install`, with no build step.
 */

const connectionString = process.env["DATABASE_URL"]?.trim();

if (connectionString === undefined || connectionString === "") {
  process.stderr.write(
    "DATABASE_URL is not set. Point it at the database to migrate, for example " +
      "postgres://user:password@localhost:5432/porkbot.\n",
  );
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });

try {
  const report = await runMigrations(pool);
  const passwords = readRolePasswords(process.env);

  await setRolePasswords(pool, passwords);

  process.stdout.write(`${formatMigrationReport(report)}\n`);
} catch (error) {
  process.stderr.write(`db:migrate failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
