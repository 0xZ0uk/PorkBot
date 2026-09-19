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
import { RUN_STEP_KINDS } from "@porkbot/core";
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { attemptStatus, runStatus } from "./enums.ts";
import { user } from "./identity.ts";
import { message } from "./messages.ts";
import { task } from "./tasks.ts";
import { space } from "./tenancy.ts";
import { thread } from "./threads.ts";

// The step vocabulary as a SQL list. `drizzle-kit` does not inline template
// parameters inside a check constraint, so the values are rendered from the
// same `RUN_STEP_KINDS` the tracker writes and the check below enforces; the
// generated SQL carries literals and the migration suite compares it
// byte-for-byte.
const runStepKindList = sql.raw(RUN_STEP_KINDS.map((kind) => `'${kind}'`).join(", "));

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
 *
 * `stop_requested_at` is the operator's stop request (slice 6.7, story 21): a
 * nullable instant, set once by the API and never cleared. It is a request
 * rather than a status because the worker executing the run owns the
 * transition — the live session cancels itself, emits `run.cancelled` and lets
 * the fenced executor settle the row — so a stop survives a worker restart
 * (a resumed session finds the mark and cancels immediately) and cannot race a
 * settlement the worker is already making.
 *
 * The liveness columns (slice 6.10, PRD decision 33) are the run's own record
 * of what it is doing: `last_heartbeat_at` is the worker's last renewal,
 * `last_progress_at` the last event it emitted, and `current_step` plus
 * `current_step_tool` the step it is on. `stalled_at` is the detector's
 * episode marker — set once by the watchdog, cleared by the next heartbeat
 * that reports progress — so a stall notifies once rather than every pass.
 * A heartbeat renews the lease; only progress moves `last_progress_at`, which
 * is the distinction "work versus hang" is built from. `current_step` is a
 * closed vocabulary checked against `@porkbot/core`'s `RUN_STEP_KINDS`, and
 * the tool is only meaningful for the two kinds that name one.
 *
 * `notified_at` (slice 8.7) is the terminal notification's claim: a guarded
 * write sets it before the operator is told a run finished or failed, so the
 * same run state is announced at most once — a second producer, a retry or a
 * concurrent recovery pass finds the claim taken. A `cancelled` run is the
 * operator's own act and never claims one; a stall claims per episode through
 * `stalled_at`, because a run that resumes and stalls again is a new thing to
 * say.
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
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
    currentStep: text("current_step"),
    currentStepTool: text("current_step_tool"),
    stalledAt: timestamp("stalled_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
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
    check(
      "run_current_step_check",
      sql`${table.currentStep} is null or ${table.currentStep} in (${runStepKindList})`,
    ),
    check(
      "run_current_step_tool_check",
      sql`${table.currentStepTool} is null or ${table.currentStep} in ('working', 'waiting')`,
    ),
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
