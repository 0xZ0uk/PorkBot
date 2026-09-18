import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSuiteDatabase, findRepoRoot } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findUnindexedForeignKeys,
  formatUnindexedForeignKeys,
} from "../../src/catalog/fk-indexes.ts";
import { migrationsDirectory, readSqlMigrationFiles } from "../../src/migrations/files.ts";

/**
 * The migration workflow against the real database: a suite cloned from the
 * testkit template, where the template is a migrated Postgres of the
 * production major. The tests prove the parts that only a server can:
 *
 *   - `pnpm db:migrate` applies the committed journal, records it in drizzle's
 *     ledger and does nothing on a second run;
 *   - the uuidv7 default the schema convention relies on exists on that server;
 *   - the foreign-key index check reads `pg_catalog` and can actually fail,
 *     proven by fixtures that violate it before they satisfy it.
 */

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_migrations" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

function runDbMigrate(): { status: number | null; stdout: string; stderr: string } {
  if (suite === undefined) {
    throw new Error("the suite was not created; the beforeAll hook failed first");
  }

  const repoRoot = findRepoRoot(packageRoot);
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "packages", "db", "src", "migrate-cli.ts")],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, DATABASE_URL: suite.connectionString },
    },
  );

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the migrated template", () => {
  it("is a Postgres whose uuidv7() produces a version 7 UUID", async () => {
    const { rows } = await db().query<{ id: string }>("select uuidv7()::text as id");

    expect(rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("has no unindexed foreign keys in the application schema", async () => {
    const violations = await findUnindexedForeignKeys(db(), "public");

    expect(violations, formatUnindexedForeignKeys(violations)).toEqual([]);
  });
});

describe("the foreign-key index check", () => {
  it("flags an unindexed FK, ignores a non-leading index, and clears when indexed", async () => {
    await db().query("create schema fk_probe");
    await db().query("create table fk_probe.parent (id integer primary key)");
    await db().query(
      "create table fk_probe.child (" +
        "id integer primary key, " +
        "parent_id integer not null references fk_probe.parent (id))",
    );

    const before = await findUnindexedForeignKeys(db(), "fk_probe");

    expect(before.map((violation) => violation.table)).toEqual(["fk_probe.child"]);
    expect(before[0]?.columns).toEqual(["parent_id"]);

    // An index that does not lead with the foreign key's columns is not a
    // lookup index for the FK, so the violation stands.
    await db().query("create index child_id_parent_idx on fk_probe.child (id, parent_id)");
    expect(await findUnindexedForeignKeys(db(), "fk_probe")).toHaveLength(1);

    // Nor does a partial index: a lookup outside its predicate is still a scan.
    await db().query(
      "create index child_parent_partial_idx on fk_probe.child (parent_id) where id > 0",
    );
    expect(await findUnindexedForeignKeys(db(), "fk_probe")).toHaveLength(1);

    await db().query("create index child_parent_idx on fk_probe.child (parent_id)");
    expect(await findUnindexedForeignKeys(db(), "fk_probe")).toEqual([]);
  });
});

describe("pnpm db:migrate", () => {
  it("applies the journal once and is safe to run twice", async () => {
    // Derived from the committed files, not hardcoded: the count moves with
    // every slice that adds a migration, and the assertion is about applying
    // the whole set exactly once rather than about a particular size.
    const total = readSqlMigrationFiles(migrationsDirectory()).length;

    expect(total).toBeGreaterThan(0);

    // A database with no application schema, like a fresh deployment: the
    // template is migrated through the testkit's ledger, so its clone is reset
    // to prove this command's own ledger and locking behaviour.
    await db().query("drop schema if exists public cascade");
    await db().query("create schema public");
    await db().query("drop schema if exists drizzle cascade");

    const first = runDbMigrate();

    expect(first.stderr, first.stderr).toBe("");
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`applied ${total} migration(s)`);

    const { rows: applied } = await db().query<{ count: number }>(
      "select count(*)::int as count from drizzle.__drizzle_migrations",
    );

    expect(applied[0]?.count).toBe(total);

    const second = runDbMigrate();

    expect(second.stderr, second.stderr).toBe("");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(`up to date: ${total} migration(s) already applied`);

    const { rows: afterSecond } = await db().query<{ count: number }>(
      "select count(*)::int as count from drizzle.__drizzle_migrations",
    );

    expect(afterSecond[0]?.count).toBe(total);
  });
});
