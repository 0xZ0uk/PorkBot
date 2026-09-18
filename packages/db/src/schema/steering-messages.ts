import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId } from "./columns.ts";
import { user } from "./identity.ts";
import { message } from "./messages.ts";
import { run } from "./runs.ts";

/**
 * The delivery record for a message sent into a live run.
 *
 * The message row already carries the duplicate-send nonce; this table records
 * that the message is a steering command, which bot it targets, the run the
 * send addressed, and whether that run has claimed it. `(message_id, bot_id)`
 * is unique so two concurrent deliveries of the same command cannot both
 * queue, and `claimed_at` is the handoff mark — set once, by the run that
 * consumed it. `run_id` is written by the send, which already resolved the
 * thread's live run: binding the steer to that run is what lets a claim from a
 * different (or finished) run refuse it, and the column is cleared rather than
 * cascaded if the run row is removed.
 */
export const steeringMessage = pgTable(
  "steering_message",
  {
    id: primaryKeyId(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("steering_message_message_bot_unique").on(table.messageId, table.botId),
    index("steering_message_bot_id_idx").on(table.botId),
    index("steering_message_run_id_idx").on(table.runId),
    index("steering_message_user_id_idx").on(table.userId),
  ],
);
