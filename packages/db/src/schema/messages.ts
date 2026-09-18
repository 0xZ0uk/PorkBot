import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
import { messageRole } from "./enums.ts";
import { run } from "./runs.ts";
import { thread } from "./threads.ts";

/**
 * A persisted thread message.
 *
 * `client_nonce` is the duplicate-send defence: NOT NULL, unique per thread, so
 * a resubmitted send collides at the database instead of racing a read-then-
 * write. The reference implementation left the column nullable, which made the
 * unique index vacuous — Postgres treats each NULL as distinct — and exactly
 * the resubmission the constraint existed to stop slipped through. Every writer
 * supplies a stable key; the database's only demand is that one exists.
 *
 * `(thread_id, seq)` is both the ordering index and a uniqueness guarantee:
 * seq is allocated from the thread's counter, so the index that serves
 * `order by seq` fails an insert that would reuse a position.
 *
 * `run_id` is nullable because a user message exists before the run it starts;
 * it is the run that points back at its source message. `on delete set null`
 * clears the link if the run row is removed, which keeps the transcript and
 * drops the association rather than the message.
 */
export const message = pgTable(
  "message",
  {
    id: primaryKeyId(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: messageRole("role").notNull(),
    blocks: jsonb("blocks").notNull(),
    runId: uuid("run_id").references((): AnyPgColumn => run.id, { onDelete: "set null" }),
    clientNonce: text("client_nonce").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_thread_seq_unique").on(table.threadId, table.seq),
    uniqueIndex("message_thread_client_nonce_unique").on(table.threadId, table.clientNonce),
    index("message_run_id_idx").on(table.runId),
  ],
);
