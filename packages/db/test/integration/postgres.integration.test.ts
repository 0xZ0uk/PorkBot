import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The integration tier's reason to exist: prove that the database these tests
// talk to is a real Postgres of the same major production runs, reached over a
// real socket, in the same run that gates the merge. A tier that skips itself
// when the service is missing is worse than no tier, so a missing DATABASE_URL
// is a hard failure rather than a skip.
//
// Production is Postgres 18 (see slice 2.1 and the `integration` job's service
// image in .github/workflows/ci.yml).

const productionMajor = 18;

const connectionString = process.env["DATABASE_URL"];

if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error(
    "DATABASE_URL is not set, so the integration tier cannot reach a Postgres. " +
      "Set it to a real server of major " +
      `${productionMajor} (see the integration job in .github/workflows/ci.yml).`,
  );
}

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("the integration tier's Postgres", () => {
  it("is a real server and not a stub", async () => {
    const { rows } = await client.query<{ version: string }>("select version() as version");

    expect(rows[0]?.version).toMatch(/^PostgreSQL /);
  });

  it(`runs major ${productionMajor}, the same major as production`, async () => {
    const { rows } = await client.query<{ server_version_num: string }>("show server_version_num");

    const version = Number(rows[0]?.server_version_num);
    expect(Number.isFinite(version)).toBe(true);
    expect(version).toBeGreaterThanOrEqual(productionMajor * 10_000);
    expect(version).toBeLessThan((productionMajor + 1) * 10_000);
  });

  it("accepts a write and reads it back over the same connection", async () => {
    await client.query(
      "create table if not exists integration_smoke (id integer primary key, note text not null)",
    );
    await client.query(
      "insert into integration_smoke (id, note) values ($1, $2) " +
        "on conflict (id) do update set note = excluded.note",
      [1, "round trip"],
    );

    const { rows } = await client.query<{ note: string }>(
      "select note from integration_smoke where id = $1",
      [1],
    );

    expect(rows[0]?.note).toBe("round trip");
  });

  it("discards a rolled back write", async () => {
    await client.query("begin");
    await client.query("insert into integration_smoke (id, note) values ($1, $2)", [
      2,
      "rolled back",
    ]);
    await client.query("rollback");

    const { rows } = await client.query<{ count: string }>(
      "select count(*)::text as count from integration_smoke where id = $1",
      [2],
    );

    expect(rows[0]?.count).toBe("0");
  });
});
