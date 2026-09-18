import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { productionPostgresMajor } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The integration tier's reason to exist: prove that the database these tests
 * talk to is a real Postgres of the same major production runs, reached over a
 * real socket, in the same run that gates the merge.
 *
 * The database is a testkit suite — a clone of the migrated template (see
 * packages/testkit/src/harness). In CI the harness attaches to the local
 * stack's Postgres; locally it boots its own container unless
 * TESTKIT_DATABASE_URL says otherwise. Either way the server is the production
 * major and the template carries the migrations the repository committed —
 * the empty baseline, the identity and tenancy tables from slice 2.2, and the
 * runs tables when slice 2.3 lands.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_integration" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();
}, 180_000);

// Tolerates a failed beforeAll so the real error is the one reported instead of
// a teardown crash on an uninitialised client.
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

describe("the integration tier's Postgres", () => {
  it("is a real server and not a stub", async () => {
    const { rows } = await db().query<{ version: string }>("select version() as version");

    expect(rows[0]?.version).toMatch(/^PostgreSQL /);
  });

  it(`runs major ${productionPostgresMajor}, the same major as production`, async () => {
    const { rows } = await db().query<{ server_version_num: string }>("show server_version_num");

    const version = Number(rows[0]?.server_version_num);
    expect(Number.isFinite(version)).toBe(true);
    expect(version).toBeGreaterThanOrEqual(productionPostgresMajor * 10_000);
    expect(version).toBeLessThan((productionPostgresMajor + 1) * 10_000);
  });

  it("accepts a write and reads it back over the same connection", async () => {
    await db().query(
      "create table if not exists integration_smoke (id integer primary key, note text not null)",
    );
    await db().query(
      "insert into integration_smoke (id, note) values ($1, $2) " +
        "on conflict (id) do update set note = excluded.note",
      [1, "round trip"],
    );

    const { rows } = await db().query<{ note: string }>(
      "select note from integration_smoke where id = $1",
      [1],
    );

    expect(rows[0]?.note).toBe("round trip");
  });

  it("discards a rolled back write", async () => {
    await db().query("begin");
    await db().query("insert into integration_smoke (id, note) values ($1, $2)", [
      2,
      "rolled back",
    ]);
    await db().query("rollback");

    const { rows } = await db().query<{ count: string }>(
      "select count(*)::text as count from integration_smoke where id = $1",
      [2],
    );

    expect(rows[0]?.count).toBe("0");
  });
});
