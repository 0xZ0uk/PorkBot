import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresHarness } from "../../src/harness/postgres.ts";
import type { PostgresHarness, SuiteDatabase } from "../../src/harness/postgres.ts";
import { productionPostgresMajor } from "../../src/harness/postgres.ts";

/**
 * The harness's own proof, against a real container. There is no mock here on
 * purpose: the acceptance criteria are about a real server of the production
 * major, a real template clone and real row isolation, and a fake would only
 * prove the fake.
 *
 * One harness (one container, one migrated template, from
 * test/fixtures/migrations) serves every suite below, which is also the shape
 * the cost measurements document: the container and the migration are paid
 * once per run, and each suite pays a clone.
 */

const fixturesDirectory = fileURLToPath(new URL("../fixtures/migrations", import.meta.url));

let harness: PostgresHarness;

// The harness's own admin connections need the password; printed strings are
// redacted now, so the tests ask for it explicitly.
function adminConnectionString(): string {
  return harness.connectionString(undefined, { includePassword: true });
}

function report(line: string): void {
  process.stdout.write(`[harness] ${line}\n`);
}

function appendToSummary(markdown: string): void {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];

  if (summaryFile !== undefined && summaryFile !== "") {
    appendFileSync(summaryFile, `${markdown}\n`);
  }
}

async function withClient<T>(
  connectionString: string,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });

  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function widgets(connectionString: string): Promise<{ id: number; label: string }[]> {
  return withClient(
    connectionString,
    async (client) =>
      (
        await client.query<{ id: number; label: string }>(
          "select id, label from widgets order by id",
        )
      ).rows,
  );
}

beforeAll(async () => {
  harness = await startPostgresHarness({ migrationsDir: fixturesDirectory, report });
}, 180_000);

afterAll(async () => {
  // Guarded so a failed boot reports the boot error, not a teardown TypeError.
  if (harness !== undefined) {
    await harness.stop();
  }
});

describe("the testkit Postgres harness", () => {
  it(`runs Postgres ${productionPostgresMajor}, the production major`, async () => {
    expect(harness.serverMajor).toBe(productionPostgresMajor);

    const { version } = await withClient(adminConnectionString(), async (client) => {
      const { rows } = await client.query<{ version: string }>("select version() as version");

      return rows[0] ?? { version: "" };
    });

    expect(version).toMatch(/^PostgreSQL /);
  });

  it("clones a fresh database from the migrated template", async () => {
    const first = await harness.createSuite("clone_first");

    try {
      expect(await widgets(first.connectionString)).toEqual([
        { id: 1, label: "a widget from the template" },
      ]);

      await withClient(first.connectionString, (client) =>
        client.query("insert into widgets (id, label) values (2, 'written by the first suite')"),
      );
      expect(await widgets(first.connectionString)).toHaveLength(2);
    } finally {
      await first.destroy();
    }

    // A later clone is fresh: the template is still exactly the migrated state,
    // so the row the first suite wrote is nowhere to be seen.
    const second = await harness.createSuite("clone_second");

    try {
      expect(await widgets(second.connectionString)).toEqual([
        { id: 1, label: "a widget from the template" },
      ]);
    } finally {
      await second.destroy();
    }
  });

  it("keeps two suites running in parallel from seeing each other's rows", async () => {
    const suites = await Promise.all([
      harness.createSuite("parallel_alpha"),
      harness.createSuite("parallel_beta"),
    ]);
    const alpha = suites[0];
    const beta = suites[1];

    if (alpha === undefined || beta === undefined) {
      throw new Error("expected two suites from the parallel clone");
    }

    try {
      await Promise.all([
        withClient(alpha.connectionString, (client) =>
          client.query("insert into widgets (id, label) values (101, 'alpha')"),
        ),
        withClient(beta.connectionString, (client) =>
          client.query("insert into widgets (id, label) values (201, 'beta')"),
        ),
      ]);

      const alphaRows = await widgets(alpha.connectionString);
      const betaRows = await widgets(beta.connectionString);

      expect(alphaRows.map((row) => row.id)).toEqual([1, 101]);
      expect(betaRows.map((row) => row.id)).toEqual([1, 201]);
      expect(alphaRows.some((row) => row.label === "beta")).toBe(false);
      expect(betaRows.some((row) => row.label === "alpha")).toBe(false);
    } finally {
      await Promise.all([alpha.destroy(), beta.destroy()]);
    }
  });

  it("drops a suite's database when the suite is destroyed", async () => {
    const suite: SuiteDatabase = await harness.createSuite("destroy_proof");

    const present = await withClient(adminConnectionString(), async (client) => {
      const { rows } = await client.query<{ present: boolean }>(
        "select exists(select 1 from pg_database where datname = $1) as present",
        [suite.database],
      );

      return rows[0]?.present === true;
    });

    expect(present).toBe(true);

    await suite.destroy();

    const stillPresent = await withClient(adminConnectionString(), async (client) => {
      const { rows } = await client.query<{ present: boolean }>(
        "select exists(select 1 from pg_database where datname = $1) as present",
        [suite.database],
      );

      return rows[0]?.present === true;
    });

    expect(stillPresent).toBe(false);
    await expect(withClient(suite.connectionString, () => Promise.resolve())).rejects.toThrow(
      /does not exist/i,
    );
  });

  it("re-applies nothing when the template is migrated twice", async () => {
    const second = await harness.migrate();

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0001_widgets.sql", "0002_seed_widgets.sql"]);
    expect(second.files).toEqual(["0001_widgets.sql", "0002_seed_widgets.sql"]);
  });

  it("measures the per-suite clone cost it documents", async () => {
    const suites: SuiteDatabase[] = [];

    for (const name of ["bench_1", "bench_2", "bench_3"]) {
      suites.push(await harness.createSuite(name));
    }

    try {
      const timings = harness.timings;
      const clones = suites.map((suite) => ({ name: suite.name, snapshotMs: suite.snapshotMs }));
      const cloneMilliseconds = clones.map((clone) => clone.snapshotMs);

      for (const milliseconds of cloneMilliseconds) {
        expect(Number.isFinite(milliseconds)).toBe(true);
        expect(milliseconds).toBeGreaterThanOrEqual(0);
      }

      const rows = [
        `| phase | ms |`,
        `| --- | --- |`,
        `| container start | ${Math.round(timings.containerStartMs)} |`,
        `| postgres ready | ${Math.round(timings.postgresReadyMs)} |`,
        `| migrate | ${Math.round(timings.migrateMs)} |`,
        ...clones.map((clone) => `| clone ${clone.name} | ${Math.round(clone.snapshotMs)} |`),
        `| mode | ${harness.mode} |`,
      ];

      appendToSummary(
        [
          "### Testkit Postgres harness startup cost (measured by the integration tier)",
          "",
          ...rows,
          "",
        ].join("\n"),
      );
      report(rows.join("\n"));
    } finally {
      await Promise.all(suites.map((suite) => suite.destroy()));
    }
  });
});
