import { is } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./index.ts";

/**
 * The schema-contract suite: the rules slice 2.2's acceptance criteria state,
 * read from Drizzle's table metadata so they are enforced before a database is
 * involved and inherited by every table the next slices add.
 *
 * Four rules live here:
 *
 *   1. A unique index over a nullable column is vacuous — Postgres treats each
 *      NULL as distinct — so every unique index, unique constraint and unique
 *      column must be NOT NULL (PRD decision 5).
 *   2. Closed sets are Postgres enums; extensible sets are text (or a lookup
 *      table), never an enum (PRD decision 16).
 *   3. Every foreign key resolves to the id of a table in this schema. The
 *      runs domain added genuinely optional links, so a nullable foreign key is
 *      allowed only with `on delete set null`: the constraint must not dangle.
 *   4. `deployment_settings.signups_enabled` has no default, so a settings row
 *      cannot exist without someone writing the value down (PRD decision 8).
 *      The companion check constraint — open signups require an admin email —
 *      is proven against a real server in the integration tier.
 */

interface UniqueIndex {
  readonly name: string;
  readonly columns: readonly PgColumn[];
  readonly unresolved: readonly string[];
}

function tables(): [name: string, table: PgTable][] {
  const found: [name: string, table: PgTable][] = [];

  for (const [name, value] of Object.entries(schema)) {
    if (is(value, PgTable)) {
      found.push([name, value]);
    }
  }

  return found;
}

function uniqueIndexesOf(table: PgTable): UniqueIndex[] {
  const config = getTableConfig(table);
  const columnsByName = new Map(config.columns.map((column) => [column.name, column]));
  const unique: UniqueIndex[] = [];

  const resolve = (name: string | undefined): PgColumn | undefined =>
    name === undefined ? undefined : columnsByName.get(name);

  for (const index of config.indexes) {
    if (!index.config.unique) {
      continue;
    }

    const columns: PgColumn[] = [];
    const unresolved: string[] = [];

    // Drizzle records index members as `IndexedColumn` names, not the table's
    // column objects, so NOT NULL is read back through the table's column map.
    for (const entry of index.config.columns) {
      const name = (entry as { name?: string }).name;
      const column = resolve(name);

      if (column === undefined) {
        unresolved.push(name ?? "an SQL expression");
      } else {
        columns.push(column);
      }
    }

    unique.push({ name: index.config.name ?? "(unnamed)", columns, unresolved });
  }

  for (const constraint of config.uniqueConstraints) {
    unique.push({
      name: constraint.name ?? `${config.name}.(unnamed unique constraint)`,
      columns: [...constraint.columns],
      unresolved: [],
    });
  }

  for (const column of config.columns) {
    if (column.isUnique) {
      unique.push({ name: `${config.name}.${column.name}`, columns: [column], unresolved: [] });
    }
  }

  return unique;
}

describe("the schema's unique constraints", () => {
  it("sit on NOT NULL columns, so a NULL cannot make them vacuous", () => {
    const violations: string[] = [];
    let found = 0;

    for (const [table, definition] of tables()) {
      for (const index of uniqueIndexesOf(definition)) {
        found += 1;

        for (const column of index.columns) {
          if (!column.notNull) {
            violations.push(
              `${table}.${column.name} is nullable but part of unique index ${index.name}; ` +
                "make it NOT NULL or drop the index",
            );
          }
        }

        if (index.unresolved.length > 0) {
          violations.push(
            `${table}'s unique index ${index.name} is on an expression; its NOT NULL columns ` +
              "cannot be proven from the schema",
          );
        }
      }
    }

    expect(
      found,
      "the schema declares no unique indexes; this test would pass vacuously",
    ).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("include the memberships, sessions and credentials the dedupe argument covers", () => {
    const names = new Set(
      tables().flatMap(([table, definition]) =>
        uniqueIndexesOf(definition).map((index) => `${table}.${index.name}`),
      ),
    );

    expect(names).toContain("user.user_email_unique");
    expect(names).toContain("session.session_token_unique");
    expect(names).toContain("account.account_provider_account_unique");
    expect(names).toContain("spaceMember.space_member_space_user_unique");
    expect(names).toContain("verification.verification_identifier_value_unique");
  });
});

describe("the schema's foreign keys", () => {
  it("resolve to the id of a table in this schema, and never dangle", () => {
    const known = new Set(tables().map(([, table]) => table));
    const resolved = tables().flatMap(([table, definition]) =>
      getTableConfig(definition).foreignKeys.map((key) => ({
        table,
        constraint: key.getName(),
        reference: key.reference(),
        onDelete: key.onDelete,
      })),
    );

    expect(resolved.length, "the schema declares no foreign keys").toBeGreaterThan(0);

    for (const { table, constraint, reference, onDelete } of resolved) {
      expect(known.has(reference.foreignTable), `${constraint} points outside the schema`).toBe(
        true,
      );
      expect(
        reference.foreignColumns.map((column) => column.name),
        constraint,
      ).toEqual(["id"]);

      for (const column of reference.columns) {
        if (column.notNull) {
          continue;
        }

        // The runs domain added optional relationships the identity tables did
        // not have: a bot without a section, a user message before its run
        // exists, a routine run with no source message. A nullable foreign key
        // is allowed, but only one that clears its link when the target is
        // deleted — `set null` keeps the row and drops the association, where
        // a cascade would delete a row the author meant to keep and no action
        // would refuse the delete outright.
        expect(
          onDelete,
          `${table}.${column.name} is nullable; its foreign key must set null on delete`,
        ).toBe("set null");
      }
    }
  });
});

describe("the schema's closed and extensible sets", () => {
  it("types the membership role as an enum with exactly the closed values", () => {
    const role = getTableConfig(schema.spaceMember).columns.find(
      (column) => column.name === "role",
    );

    expect(role?.columnType).toBe("PgEnumColumn");
    expect(role?.enumValues).toEqual(["owner", "member"]);
    expect(role?.notNull).toBe(true);
  });

  it("types the provider kind as text, because the set of providers is extensible", () => {
    const provider = getTableConfig(schema.account).columns.find(
      (column) => column.name === "provider_id",
    );

    expect(provider?.columnType).toBe("PgText");
    expect(provider?.notNull).toBe(true);
  });
});

describe("the deployment settings", () => {
  it("require an explicit signups value: NOT NULL with no default", () => {
    const signups = getTableConfig(schema.deploymentSettings).columns.find(
      (column) => column.name === "signups_enabled",
    );

    expect(signups?.notNull).toBe(true);
    expect(signups?.hasDefault).toBe(false);
  });

  it("carry the signups-open-requires-an-admin check constraint", () => {
    const checks = getTableConfig(schema.deploymentSettings).checks;

    expect(checks.map((check) => check.name)).toContain(
      "deployment_settings_signups_require_admin",
    );
  });
});
