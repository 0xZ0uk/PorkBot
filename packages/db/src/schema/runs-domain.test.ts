import { RUN_STATUSES } from "@porkbot/core";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { bot } from "./bots.ts";
import { attemptStatus, effectStatus, runStatus, taskStatus } from "./enums.ts";
import { event } from "./events.ts";
import { externalEffect } from "./external-effects.ts";
import { message } from "./messages.ts";
import { attempt, run } from "./runs.ts";
import { steeringMessage } from "./steering-messages.ts";
import { task } from "./tasks.ts";

/**
 * The slice 2.3 acceptance criteria, as assertions over the schema the
 * migration is generated from. The database half of each rule lives in the
 * integration suite; these tests catch a regression before it becomes a
 * migration, and they name the criterion they enforce:
 *
 *   - statuses are Postgres enums, and run status cannot drift from core;
 *   - idempotency keys are NOT NULL and uniquely scoped, with the scope spelled
 *     out (the generic "no unique index is vacuous" rule lives in
 *     `constraints.test.ts` and applies to every table);
 *   - the run lease is a monotonically usable integer, the checkpoint is never
 *     NULL, and the claim scan is indexed;
 *   - message and event ordering is indexed by (thread, seq).
 */

function configOf(table: PgTable) {
  return getTableConfig(table);
}

function columnOf(table: PgTable, name: string): PgColumn {
  const column = configOf(table).columns.find((candidate) => candidate.name === name);

  if (column === undefined) {
    throw new Error(`${configOf(table).name} has no column "${name}"`);
  }

  return column;
}

/**
 * The array-config index builder stores plain `IndexedColumn` values with the
 * column's SQL name; a raw SQL entry has none. The schema uses only column
 * references, and a non-column entry is reported rather than skipped so the
 * test fails loudly if that ever changes.
 */
function indexColumns(table: PgTable, indexName: string): string[] {
  const index = configOf(table).indexes.find((candidate) => candidate.config.name === indexName);

  if (index === undefined) {
    throw new Error(`${configOf(table).name} has no index "${indexName}"`);
  }

  return index.config.columns.map((column) => {
    const name = (column as { readonly name?: string }).name;

    if (name === undefined) {
      throw new Error(`${configOf(table).name}'s ${indexName} indexes an expression, not a column`);
    }

    return name;
  });
}

function uniqueIndexOf(table: PgTable, indexName: string) {
  const index = configOf(table).indexes.find((candidate) => candidate.config.name === indexName);

  if (index === undefined) {
    throw new Error(`${configOf(table).name} has no index "${indexName}"`);
  }

  expect(index.config.unique, `${indexName} must be unique`).toBe(true);

  return index;
}

function enumValuesOf(column: PgColumn): readonly string[] {
  return (column as unknown as { readonly enumValues: readonly string[] }).enumValues;
}

describe("typed statuses", () => {
  const statusColumns = [
    { table: run, name: "run", column: "status", expected: runStatus.enumValues },
    { table: task, name: "task", column: "status", expected: taskStatus.enumValues },
    { table: attempt, name: "attempt", column: "status", expected: attemptStatus.enumValues },
    {
      table: externalEffect,
      name: "external_effect",
      column: "status",
      expected: effectStatus.enumValues,
    },
  ];

  it("stores every status as the Postgres enum that owns its vocabulary", () => {
    for (const { table, name, column, expected } of statusColumns) {
      const status = columnOf(table, column);

      expect(status.columnType, `${name}.${column} must be a Postgres enum`).toBe("PgEnumColumn");
      expect(status.notNull, `${name}.${column} must be NOT NULL`).toBe(true);
      expect(enumValuesOf(status)).toEqual(expected);
    }
  });

  it("sources the run-status enum from the core state machine, not a restatement", () => {
    expect(runStatus.enumValues).toEqual([...RUN_STATUSES]);
  });

  it("constrains the extensible run trigger with a check instead of an enum", () => {
    const checks = configOf(run).checks.map((check) => check.name);

    expect(checks).toContain("run_trigger_check");
    expect(columnOf(run, "trigger").columnType).toBe("PgText");
  });
});

describe("idempotency keys", () => {
  const idempotencyKeys = [
    {
      table: bot,
      tableName: "bot",
      column: "spawn_key",
      index: "bot_space_spawn_key_unique",
      scope: ["space_id", "spawn_key"],
    },
    {
      table: message,
      tableName: "message",
      column: "client_nonce",
      index: "message_thread_client_nonce_unique",
      scope: ["thread_id", "client_nonce"],
    },
    {
      table: run,
      tableName: "run",
      column: "client_nonce",
      index: "run_space_client_nonce_unique",
      scope: ["space_id", "client_nonce"],
    },
    {
      table: externalEffect,
      tableName: "external_effect",
      column: "idempotency_key",
      index: "external_effect_run_idempotency_key_unique",
      scope: ["run_id", "idempotency_key"],
    },
  ];

  it("makes every idempotency key NOT NULL and uniquely scoped", () => {
    for (const { table, tableName, column, index, scope } of idempotencyKeys) {
      expect(columnOf(table, column).notNull, `${tableName}.${column} must be NOT NULL`).toBe(true);
      uniqueIndexOf(table, index);
      expect(indexColumns(table, index), `${tableName}'s ${index} must be scoped`).toEqual(scope);
    }
  });

  it("scopes duplicate-send protection for attempts and steering commands too", () => {
    uniqueIndexOf(attempt, "attempt_run_fence_unique");
    expect(indexColumns(attempt, "attempt_run_fence_unique")).toEqual(["run_id", "fence"]);

    uniqueIndexOf(steeringMessage, "steering_message_message_bot_unique");
    expect(indexColumns(steeringMessage, "steering_message_message_bot_unique")).toEqual([
      "message_id",
      "bot_id",
    ]);
  });
});

describe("the run lease and checkpoint", () => {
  it("gives the fence a NOT NULL integer defaulting to zero", () => {
    const fence = columnOf(run, "lease_fence");

    expect(fence.columnType).toBe("PgInteger");
    expect(fence.notNull).toBe(true);
    expect(fence.hasDefault).toBe(true);
    expect(fence.default).toBe(0);
  });

  it("leaves owner and expiry nullable: an unclaimed run has neither", () => {
    expect(columnOf(run, "lease_owner").notNull).toBe(false);
    expect(columnOf(run, "lease_expires_at").notNull).toBe(false);
  });

  it("makes the checkpoint a non-null jsonb object, so reclaim cannot mean restart", () => {
    const checkpoint = columnOf(run, "checkpoint");

    expect(checkpoint.columnType).toBe("PgJsonb");
    expect(checkpoint.notNull).toBe(true);
    expect(checkpoint.hasDefault).toBe(true);
  });

  it("indexes the claim scan over expired leases", () => {
    expect(indexColumns(run, "run_status_lease_expires_idx")).toEqual([
      "status",
      "lease_expires_at",
    ]);
  });
});

describe("thread ordering", () => {
  it("indexes message ordering by (thread, seq) and forbids a reused position", () => {
    uniqueIndexOf(message, "message_thread_seq_unique");
    expect(indexColumns(message, "message_thread_seq_unique")).toEqual(["thread_id", "seq"]);
  });

  it("indexes event ordering by (thread, seq) and forbids a reused position", () => {
    uniqueIndexOf(event, "event_thread_seq_unique");
    expect(indexColumns(event, "event_thread_seq_unique")).toEqual(["thread_id", "seq"]);
  });
});
