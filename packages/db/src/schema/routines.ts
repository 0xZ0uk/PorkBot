import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { user } from "./identity.ts";
import { run } from "./runs.ts";
import { space } from "./tenancy.ts";
import { thread } from "./threads.ts";

/**
 * Routines: a scheduled instruction as a row (PRD decision 22, slice 8.4).
 *
 * A routine is not a cron string buried in a bot's configuration. It has an
 * owner, a bot, an instruction, a timezone and a five-field cron expression,
 * plus the `next_run_at` instant the scheduler is waiting on. `cron` is text
 * and not an enum for the same reason `run.trigger` is: the set of expressions
 * is unbounded and the grammar is `@porkbot/core`'s, not the database's.
 *
 * `next_run_at` is the schedule's cursor and it is NOT NULL: a live routine
 * always has a next fire, because "no next fire" is what disabling or deleting
 * means. The scheduler advances it with a compare-and-swap on the value it
 * read, so two passes cannot both settle one slot, and `routine_due_idx` — a
 * partial index over exactly the enabled, live rows the scan asks for — keeps
 * the minute pass off the whole table.
 *
 * Deleting is `deleted_at`, never a row delete: the issue's rule is that
 * disabling or deleting stops future runs without deleting history, and the
 * occurrence ledger below holds that history. A tombstoned routine keeps its
 * thread and its runs, and the API filters it out; nothing cascades from it.
 * The enabled flag and the tombstone are separate because pausing and deleting
 * are different intents — a paused routine keeps its place in a list, a
 * deleted one does not. The row does cascade from its bot, thread, user and
 * space like every other runs-domain row: a wholesale bot deletion is the
 * destructive act that removes its routines, while the delete the product
 * performs — removing one routine — is the tombstone above.
 *
 * `thread_id` is the routine's dedicated conversation, created with it. Every
 * scheduled run lands in that one thread, so an operator reads a routine's
 * work as one history rather than a thread per fire.
 */
export const routine = pgTable(
  "routine",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    instruction: text("instruction").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    check(
      "routine_identifiers_check",
      sql`length(btrim(${table.instruction})) > 0 and length(btrim(${table.cron})) > 0 and length(btrim(${table.timezone})) > 0`,
    ),
    index("routine_space_bot_idx").on(table.spaceId, table.botId),
    index("routine_bot_id_idx").on(table.botId),
    index("routine_user_id_idx").on(table.userId),
    index("routine_thread_id_idx").on(table.threadId),
    index("routine_due_idx")
      .on(table.nextRunAt)
      .where(sql`enabled and deleted_at is null`),
  ],
);

/**
 * The occurrence ledger: one row per scheduled fire time the scheduler settled.
 *
 * An occurrence with a `run_id` is a fire, and the run's own status is its
 * outcome — success, failure, cancelled or still running. An occurrence with a
 * null `run_id` is a missed schedule: the slot passed beyond the grace and was
 * deliberately not run. That shape makes "a missed schedule is visible" a row
 * a client can render, not an inference from a gap in timestamps, and it keeps
 * the run's status the single authority on how a fire ended instead of copying
 * it into a second status column that could drift.
 *
 * `(routine_id, scheduled_for)` is unique on NOT NULL columns, so the scheduler
 * is idempotent by construction: a retried pass that re-addresses a slot
 * inserts nothing and is answered by the row. `run_id` is nullable and sets
 * null when its run is deleted, so a purged run loses its link but never
 * silently becomes a missed schedule.
 */
export const routineOccurrence = pgTable(
  "routine_occurrence",
  {
    id: primaryKeyId(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routine.id, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    runId: uuid("run_id").references((): AnyPgColumn => run.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("routine_occurrence_routine_scheduled_unique").on(
      table.routineId,
      table.scheduledFor,
    ),
    index("routine_occurrence_run_id_idx").on(table.runId),
  ],
);
