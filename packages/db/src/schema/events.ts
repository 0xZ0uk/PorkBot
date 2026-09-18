import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryKeyId } from "./columns.ts";
import { run } from "./runs.ts";
import { space } from "./tenancy.ts";
import { thread } from "./threads.ts";

/**
 * A run event, persisted so a transcript survives the stream that produced it.
 *
 * `seq` is allocated from the thread's counter and `(thread_id, seq)` is unique
 * and indexed: it is the ordering index a subscription replays from, and it
 * fails an insert that would reuse a position. A reconnecting client can ask
 * for everything after its cursor because the position is contiguous, not
 * arrival-ordered.
 *
 * `type` is deliberately text, not an enum. The wire vocabulary is owned by
 * `RUN_EVENT_TYPES` in `@porkbot/core` and carries a schema version precisely
 * so it can grow without a database migration per event type; the parser
 * rejects a type it does not know (PRD decision 16's extensible-set rule).
 * `run_id` is nullable because events are thread-scoped and a future thread
 * event need not belong to a run.
 */
export const event = pgTable(
  "event",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("event_thread_seq_unique").on(table.threadId, table.seq),
    index("event_run_type_seq_idx").on(table.runId, table.type, table.seq),
    index("event_space_id_idx").on(table.spaceId),
  ],
);
