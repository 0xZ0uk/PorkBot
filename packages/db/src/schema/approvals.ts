import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";
import { approvalStatus } from "./enums.ts";
import { user } from "./identity.ts";
import { run } from "./runs.ts";
import { space } from "./tenancy.ts";

/**
 * One tool call's approval gate, as durable pending state (slice 5.7, PRD
 * decision 13; audit P0 item 1).
 *
 * The row exists before the run waits and outlives every connection to it:
 * `(run_id, call_id)` is unique, where `call_id` is the model's durable call id
 * from `tool.requested`, so a restart reopens the same gate instead of asking
 * the operator twice, and a client that reloads can read the pending row rather
 * than inferring it from a socket. `expires_at` is the deadline; a timeout is a
 * compare-and-set on `status = 'pending'`, never a wall-clock guess by whoever
 * happens to be watching.
 *
 * `arguments` is the redacted tool-call payload the decision was made about
 * (slice 10.2): the operator reviews what the call would do, and the durable
 * record answers "approved what?" without a join to the event stream. The gate
 * redacts before the write, so a secret-shaped argument is not stored here.
 *
 * The resolution check makes "who, when and which call" structural:
 *
 * - a `pending` row carries no decision, no operator and no reason;
 * - `approved` / `denied` carry the deciding user and the instant, so a
 *   decision cannot lose its author;
 * - `timed_out` carries the instant and no operator, because the system denied
 *   it rather than a person — the two must not be confusable in an audit.
 *
 * `decided_by_user_id` clears on user deletion (`on delete set null`), which is
 * the schema's rule for a nullable foreign key, and the resolution check then
 * refuses the delete of an author whose approval survives: erasing the operator
 * of record would make the audit a guess. In the single-operator deployment the
 * deciding user's own runs cascade, so both rows go together.
 */
export const approval = pgTable(
  "approval",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    tool: text("tool").notNull(),
    arguments: jsonb("arguments").notNull().default({}),
    status: approvalStatus("status").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedByUserId: uuid("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("approval_run_call_unique").on(table.runId, table.callId),
    index("approval_space_id_idx").on(table.spaceId),
    index("approval_run_status_idx").on(table.runId, table.status),
    index("approval_status_expires_idx").on(table.status, table.expiresAt),
    index("approval_decided_by_user_id_idx").on(table.decidedByUserId),
    check(
      "approval_resolution_check",
      sql`(${table.status} = 'pending' and ${table.decidedAt} is null and ${table.decidedByUserId} is null and ${table.reason} is null)
        or (${table.status} in ('approved', 'denied') and ${table.decidedAt} is not null and ${table.decidedByUserId} is not null)
        or (${table.status} = 'timed_out' and ${table.decidedAt} is not null and ${table.decidedByUserId} is null)`,
    ),
    check(
      "approval_identifiers_check",
      sql`length(btrim(${table.callId})) > 0 and length(btrim(${table.tool})) > 0`,
    ),
  ],
);
