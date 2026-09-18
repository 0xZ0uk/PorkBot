import { index, integer, pgTable, uuid } from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { user } from "./identity.ts";
import { space } from "./tenancy.ts";

/**
 * A bot's conversation thread.
 *
 * `next_event_seq` and `next_message_seq` are allocation counters, not
 * conveniences: a writer takes the next number and advances the counter in the
 * same transaction that inserts the row, so ordering stays contiguous under
 * concurrent writers without a `max(seq)` read and without ever reusing a
 * number. The unique `(thread_id, seq)` indexes on `message` and `event` are
 * what make the counter the only correct way to allocate.
 */
export const thread = pgTable(
  "thread",
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
    nextEventSeq: integer("next_event_seq").notNull().default(0),
    nextMessageSeq: integer("next_message_seq").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    index("thread_bot_id_idx").on(table.botId),
    index("thread_user_id_idx").on(table.userId),
    index("thread_space_updated_idx").on(table.spaceId, table.updatedAt),
  ],
);
