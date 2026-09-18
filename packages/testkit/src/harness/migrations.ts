import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";

/**
 * The template database is migrated with plain SQL files until `packages/db`
 * grows the Drizzle migration stack (slice 2.1). The mechanics are the ones a
 * real runner has, because the harness's job is to prove the template is
 * migrated, not to pretend: files apply in filename order (`0001_...sql`,
 * `0002_...sql`), each inside a transaction, and each records a checksum in a
 * ledger table so a re-run cannot silently apply a changed file.
 *
 * A missing directory is not an error at this point in the project — it means
 * the application has no migrations yet — but the caller is told
 * (`directoryExists: false`) so it can say so out loud instead of claiming a
 * schema exists.
 */

export const migrationLedgerTable = "testkit_migrations";

export interface MigrationFile {
  readonly name: string;
  readonly path: string;
  readonly sql: string;
}

export interface MigrationReport {
  readonly directory: string;
  readonly directoryExists: boolean;
  readonly files: readonly string[];
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export function listMigrations(directory: string): MigrationFile[] {
  const status = statSync(directory, { throwIfNoEntry: false });

  if (status === undefined || !status.isDirectory()) {
    return [];
  }

  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((name) => {
      const file = path.join(directory, name);

      return { name, path: file, sql: readFileSync(file, "utf8") };
    });
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Applies every not-yet-applied file to the database `client` is connected to.
 * The caller points this at the template database; suites clone the result.
 */
export async function applyMigrations(client: Client, directory: string): Promise<MigrationReport> {
  const status = statSync(directory, { throwIfNoEntry: false });
  const directoryExists = status !== undefined && status.isDirectory();
  const migrations = listMigrations(directory);

  await client.query(
    `create table if not exists ${migrationLedgerTable} (` +
      "name text primary key, " +
      "checksum text not null, " +
      "applied_at timestamptz not null default now())",
  );

  const { rows } = await client.query<{ name: string; checksum: string }>(
    `select name, checksum from ${migrationLedgerTable}`,
  );
  const recorded = new Map(rows.map((row) => [row.name, row.checksum]));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const fileChecksum = checksum(migration.sql);
    const previous = recorded.get(migration.name);

    if (previous !== undefined) {
      if (previous !== fileChecksum) {
        throw new Error(
          `${migration.name} changed after it was applied to the template. Migrations are immutable: ` +
            "edit the ledger, not history, or destroy and start again.",
        );
      }

      skipped.push(migration.name);
      continue;
    }

    await client.query("begin");

    try {
      await client.query(migration.sql);
      await client.query(`insert into ${migrationLedgerTable} (name, checksum) values ($1, $2)`, [
        migration.name,
        fileChecksum,
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});

      throw new Error(`${migration.name} failed to apply: ${(error as Error).message}`, {
        cause: error,
      });
    }

    applied.push(migration.name);
  }

  return {
    directory,
    directoryExists,
    files: migrations.map((file) => file.name),
    applied,
    skipped,
  };
}
