import { describe, expect, it } from "vitest";
import { countAppliedMigrations, formatMigrationReport } from "./migrate.ts";
import type { Queryable } from "./queryable.ts";

interface FakeDatabase extends Queryable {
  readonly queries: string[];
}

function fakeDatabase(handler: (text: string) => unknown[]): FakeDatabase {
  const queries: string[] = [];

  return {
    queries,
    async query<Row>(text: string): Promise<{ rows: readonly Row[] }> {
      queries.push(text);

      return { rows: handler(text) as Row[] };
    },
  };
}

describe("counting the migrations a database has applied", () => {
  it("is zero when drizzle's ledger table does not exist", async () => {
    const database = fakeDatabase(() => [{ present: false }]);

    expect(await countAppliedMigrations(database)).toBe(0);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]).toContain("to_regclass");
  });

  it("is zero when the ledger table exists but has no rows to return", async () => {
    const database = fakeDatabase((text) =>
      text.includes("to_regclass") ? [{ present: true }] : [],
    );

    expect(await countAppliedMigrations(database)).toBe(0);
  });

  it("counts the rows in drizzle's ledger when it does", async () => {
    const database = fakeDatabase((text) =>
      text.includes("to_regclass") ? [{ present: true }] : [{ count: 7 }],
    );

    expect(await countAppliedMigrations(database)).toBe(7);
    expect(database.queries[1]).toContain('"drizzle"."__drizzle_migrations"');
  });
});

describe("reporting a migration run", () => {
  it("says nothing was applied when the database was current", () => {
    expect(formatMigrationReport({ folder: "/migrations", applied: 0, total: 3 })).toBe(
      "up to date: 3 migration(s) already applied",
    );
  });

  it("names the number applied and the total", () => {
    expect(formatMigrationReport({ folder: "/migrations", applied: 2, total: 3 })).toBe(
      "applied 2 migration(s), 3 total",
    );
  });
});
