import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";
import { effectStatus } from "./enums.ts";
import { run } from "./runs.ts";
import { space } from "./tenancy.ts";

/**
 * A side effect a run intends to have on the outside world.
 *
 * The row exists before the effect happens and is confirmed after, so a retried
 * effect is a no-op: `idempotency_key` is NOT NULL and unique per run (PRD
 * decision 26), and the worker's retry hits the same row instead of sending
 * twice. `status` is a Postgres enum; `request` is stored before the attempt and
 * `result` after it, so an audit can answer what was asked and what came back.
 *
 * `kind` is text rather than an enum — new effect kinds ride with new tools,
 * and the set is expected to grow. It is the tool-call surface that maps a kind
 * to an adapter, and an unknown kind there is a typed error, not a database
 * write.
 */
export const externalEffect = pgTable(
  "external_effect",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: effectStatus("status").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("external_effect_run_idempotency_key_unique").on(table.runId, table.idempotencyKey),
    index("external_effect_run_status_idx").on(table.runId, table.status),
    index("external_effect_space_id_idx").on(table.spaceId),
  ],
);
