import { is } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig, pgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./index.ts";
import { primaryKeyId } from "./columns.ts";

/**
 * The UUIDv7 convention is checked twice: once on a probe table, which proves
 * the helper emits `default uuidv7()`, and once over every table the schema
 * module exports — the identity and tenancy tables and the runs-domain tables
 * both fall under it, and every table a later slice adds inherits the guard.
 */

const dialect = new PgDialect();

function defaultSql(column: { readonly default: unknown } | undefined): string | undefined {
  if (column?.default === undefined || column.default === null) {
    return undefined;
  }

  if (typeof column.default === "string") {
    return `'${column.default}'`;
  }

  return dialect.sqlToQuery(column.default as SQL).sql;
}

function primaryKeyOf(table: PgTable): { name: string; default: unknown } | undefined {
  const column = getTableConfig(table).columns.find((candidate) => candidate.primary);

  return column === undefined ? undefined : { name: column.name, default: column.default };
}

describe("the schema's primary-key convention", () => {
  it("gives a table an id column defaulting to uuidv7()", () => {
    const probe = pgTable("uuidv7_probe", { id: primaryKeyId() });
    const primary = primaryKeyOf(probe);

    expect(primary?.name).toBe("id");
    expect(defaultSql(primary)).toBe("uuidv7()");
  });

  it("is used by every table the schema exports", () => {
    const tables: [name: string, table: PgTable][] = [];

    for (const [name, value] of Object.entries(schema)) {
      if (is(value, PgTable)) {
        tables.push([name, value]);
      }
    }

    for (const [name, table] of tables) {
      const primary = primaryKeyOf(table);

      expect(primary, `${name} has no primary key; use primaryKeyId()`).toBeDefined();
      expect(defaultSql(primary), `${name}'s primary key must default to uuidv7()`).toBe(
        "uuidv7()",
      );
    }
  });
});
