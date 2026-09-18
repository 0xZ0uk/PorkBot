import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { attemptStatus, runStatus } from "./enums.ts";
import { user } from "./identity.ts";
import { message } from "./messages.ts";
import { task } from "./tasks.ts";
import { space } from "./tenancy.ts";
import { thread } from "./threads.ts";

/**
 * The run: the lease-and-fence row the product's correctness hangs on.
 *
 * A run is claimed by a compare-and-swap update guarded on `status`,
 * `lease_owner` and `lease_fence`, with `lease_expires_at` as the TTL
 * (PRD decision 1). The schema carries those columns here; slice 6.2 writes the
 * claim, heartbeat and reclaim queries and slice 6.3 the fence-loss path. Three
 * properties are structural rather than conventional:
 *
 * - `lease_fence` is a NOT NULL integer defaulting to 0. Reclaim compares it
 *   monotonically (`set lease_fence = lease_fence + 1 where ... and
 *   lease_fence = $claimed`), so a stale owner's write matches nothing instead
 *   of overwriting the new owner's work.
 * - `lease_owner` and `lease_expires_at` are nullable because an unclaimed run
 *   has no owner and no deadline; the fence is never null, so the guard is
 *   never accidentally vacuous.
 * - `checkpoint` is NOT NULL jsonb defaulting to `{}`. The column holds the
 *   compacted session state reclaim resumes from, and a nullable checkpoint
 *   would make "resume" and "start over" indistinguishable at the type level —
 *   an empty object states "no checkpoint yet" honestly, NULL would not.
 *
 * `client_nonce` is the run's idempotency key: NOT NULL, unique per space, so
 * the single run-creation command (slice 2.10) resolves a duplicate submission
 * with an insert conflict rather than a read-then-write race. `source_message_id`
 * is nullable because a routine-triggered run has no source message, and it is
 * cleared rather than cascaded when that message is deleted.
 *
 * `trigger` is text with a check constraint rather than an enum: the set is
 * expected to grow (routines, then more), and PRD decision 16 says a growing
 * set is text plus a check, never an enum.
 */
export const run = pgTable(
  "run",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: runStatus("status").notNull(),
    trigger: text("trigger").notNull(),
    error: text("error"),
    errorCode: text("error_code"),
    leaseOwner: text("lease_owner"),
    leaseFence: integer("lease_fence").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    checkpoint: jsonb("checkpoint").notNull().default({}),
    clientNonce: text("client_nonce").notNull(),
    sourceMessageId: uuid("source_message_id").references((): AnyPgColumn => message.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("run_space_client_nonce_unique").on(table.spaceId, table.clientNonce),
    check("run_trigger_check", sql`${table.trigger} in ('message', 'routine')`),
    index("run_status_lease_expires_idx").on(table.status, table.leaseExpiresAt),
    index("run_thread_status_created_idx").on(table.threadId, table.status, table.createdAt),
    index("run_bot_id_idx").on(table.botId),
    index("run_task_id_idx").on(table.taskId),
    index("run_source_message_id_idx").on(table.sourceMessageId),
    index("run_user_id_idx").on(table.userId),
  ],
);

/**
 * One worker's execution of a run under one fence.
 *
 * An attempt is created when a worker claims the run at a fence and closed when
 * it completes, fails or loses the fence (`abandoned`). The unique
 * `(run_id, fence)` index is the idempotency guarantee: a duplicated claim
 * cannot append a second attempt row for a fence it already recorded, which is
 * what keeps "every registered job is idempotent by construction" true at the
 * table (PRD decision 17).
 */
export const attempt = pgTable(
  "attempt",
  {
    id: primaryKeyId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    fence: integer("fence").notNull(),
    status: attemptStatus("status").notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("attempt_run_fence_unique").on(table.runId, table.fence)],
);
