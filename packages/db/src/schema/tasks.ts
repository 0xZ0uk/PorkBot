import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { taskStatus } from "./enums.ts";
import { user } from "./identity.ts";
import { space } from "./tenancy.ts";
import { thread } from "./threads.ts";

/**
 * The durable unit of requested work.
 *
 * A message or a routine asks for one task; a task's runs are its executions.
 * The status is a Postgres enum, so the database rejects a value outside the
 * vocabulary, and it is set explicitly on insert — there is no default that
 * could quietly declare a task queued when the caller meant otherwise.
 */
export const task = pgTable(
  "task",
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
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    status: taskStatus("status").notNull(),
    ...timestamps(),
  },
  (table) => [
    index("task_bot_id_idx").on(table.botId),
    index("task_thread_id_idx").on(table.threadId),
    index("task_user_id_idx").on(table.userId),
    index("task_space_bot_idx").on(table.spaceId, table.botId),
  ],
);
