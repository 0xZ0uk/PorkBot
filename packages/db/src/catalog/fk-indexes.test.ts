import { describe, expect, it } from "vitest";
import {
  findUnindexedForeignKeys,
  formatUnindexedForeignKeys,
  toUnindexedForeignKeys,
  unindexedForeignKeysSql,
} from "./fk-indexes.ts";
import type { Queryable } from "../queryable.ts";

describe("reading unindexed foreign keys from the catalog", () => {
  it("maps catalog rows to violations", () => {
    expect(
      toUnindexedForeignKeys([
        { table_name: "bot", constraint_name: "bot_space_fk", column_names: ["space_id"] },
      ]),
    ).toEqual([{ table: "bot", constraint: "bot_space_fk", columns: ["space_id"] }]);
  });

  it("asks pg_catalog for the answer, not information_schema or convention", () => {
    expect(unindexedForeignKeysSql).toContain("pg_constraint");
    expect(unindexedForeignKeysSql).toContain("pg_index");
    expect(unindexedForeignKeysSql).toContain("contype = 'f'");
    expect(unindexedForeignKeysSql).not.toContain("information_schema");
  });

  it("does not accept a partial index as covering every lookup", () => {
    expect(unindexedForeignKeysSql).toContain("indpred is null");
  });

  it("passes the schema as a query parameter", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const database: Queryable = {
      async query<Row>(text: string, values?: readonly unknown[]) {
        calls.push({ text, values: values ?? [] });

        return { rows: [] as Row[] };
      },
    };

    await findUnindexedForeignKeys(database, "app");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe(unindexedForeignKeysSql);
    expect(calls[0]?.values).toEqual(["app"]);
  });

  it("formats a violation with the table, columns and constraint", () => {
    const formatted = formatUnindexedForeignKeys([
      { table: "bot", constraint: "bot_space_fk", columns: ["space_id", "archived_at"] },
    ]);

    expect(formatted).toBe(
      "bot (space_id, archived_at) has no index leading with those columns; the FK is bot_space_fk",
    );
  });
});
