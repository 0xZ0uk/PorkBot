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
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { space } from "./tenancy.ts";

/**
 * A bot's stored secret (slice 9.6, E9 epic; reference parity BotSecret).
 *
 * One row is one named credential an operator stored for one bot: the value is
 * `envelope`, AES-256-GCM text whose additional authenticated data binds it to
 * `(space, bot, name)`, so a ciphertext moved to another bot or another name
 * fails authentication before a byte is decrypted. The value is never a column
 * an ordinary read selects, and no list can return it.
 *
 * `origin` and `auth` are the destination the value is bound to — the bare
 * HTTPS origin it may be sent to and how it authenticates there. `envelope` is
 * null for a secret that was forgotten: the value is gone, the metadata stays
 * as the audit line, and the unique key lets the same name be stored again.
 * The row cascades with its bot and its space, so deleting either leaves
 * nothing behind.
 */

export const botSecret = pgTable(
  "bot_secret",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    /** The name an ask, a list and a proxy upstream are addressed by. */
    name: text("name").notNull(),
    /** The bare HTTPS origin the value may be sent to, and no other. */
    origin: text("origin").notNull(),
    /** The authentication shape: `{"type":"bearer"}` or a header or basic. */
    auth: jsonb("auth").notNull(),
    /** The ciphertext; null after a forget, never a select list's column. */
    envelope: text("envelope"),
    /** When the value was cleared; the row is the audit line a list renders. */
    forgottenAt: timestamp("forgotten_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("bot_secret_space_bot_name_unique").on(table.spaceId, table.botId, table.name),
    index("bot_secret_bot_id_idx").on(table.botId),
    index("bot_secret_space_id_idx").on(table.spaceId),
    check("bot_secret_name_check", sql`length(btrim(${table.name})) > 0`),
    check("bot_secret_origin_check", sql`length(btrim(${table.origin})) > 0`),
    check(
      "bot_secret_auth_type_check",
      sql`${table.auth}->>'type' in ('bearer', 'header', 'basic')`,
    ),
  ],
);
