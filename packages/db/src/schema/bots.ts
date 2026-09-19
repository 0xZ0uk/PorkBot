import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";
import { user } from "./identity.ts";
import { modelConnection } from "./model-connections.ts";
import { space } from "./tenancy.ts";

/**
 * Bots and the sections that group them.
 *
 * `space_id` and `user_id` are the tenancy columns every runs-domain table
 * carries, and they are real foreign keys now that the identity tables have
 * landed: deleting a space or a user takes its bots with it. `section_id` is
 * nullable because a bot need not be in a section; `on delete set null` is
 * what keeps that honest when a section is deleted, and `model_connection_id`
 * takes the same shape for the same reason.
 *
 * `spawn_key` is the bot's idempotency key: creating the same bot twice cannot
 * insert twice, because the unique index is scoped `(space_id, spawn_key)` on
 * NOT NULL columns. In the reference schema that constraint sat on a nullable
 * column, which made it vacuous; here a caller must supply the key.
 *
 * `avatar_key` is the key the avatar's bytes live under in the storage seam,
 * never a URL and never a filesystem path: the API hands the key back to a
 * `StorageProvider` to read or delete, so a remote storage backend needs no
 * schema change. `computer_id` is the assignment of a computer to the bot; the
 * `computer` table lands with epic E7 (M6), and this column becomes its foreign
 * key then. Until it does, the id is stored opaquely and indexed, and nothing
 * outside the assignment contract reads it.
 */

export const botSection = pgTable(
  "bot_section",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("bot_section_space_user_name_unique").on(table.spaceId, table.userId, table.name),
    index("bot_section_user_id_idx").on(table.userId),
    index("bot_section_space_user_position_idx").on(
      table.spaceId,
      table.userId,
      table.position,
      table.createdAt,
    ),
  ],
);

export const bot = pgTable(
  "bot",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    color: text("color").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    position: integer("position").notNull().default(0),
    sectionId: uuid("section_id").references(() => botSection.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    spawnKey: text("spawn_key").notNull(),
    avatarKey: text("avatar_key"),
    computerId: uuid("computer_id"),
    /**
     * The computer provider this bot selected, or null to use the
     * deployment's default (slice 7.3). The kinds are an extensible set, so
     * the column is text with a non-blank check rather than an enum; the
     * supervisor is what knows which kinds its deployment configured, and it
     * refuses an unknown one fail-closed at the first lifecycle call.
     */
    computerProvider: text("computer_provider"),
    /**
     * The model this bot runs, and the connection it runs on (slice 9.2). Both
     * are nullable: an unset connection falls back to the space's default, and
     * an unset model falls back to that connection's `default_model`. Setting
     * the connection is a scoped write like `section_id` — the repository
     * refuses one from another space — and the foreign key nulls the column if
     * the connection is removed, so "no selection" stays explicit.
     */
    modelConnectionId: uuid("model_connection_id").references(() => modelConnection.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("bot_space_spawn_key_unique").on(table.spaceId, table.spawnKey),
    index("bot_section_id_idx").on(table.sectionId),
    index("bot_computer_id_idx").on(table.computerId),
    index("bot_model_connection_id_idx").on(table.modelConnectionId),
    index("bot_user_id_idx").on(table.userId),
    index("bot_space_user_archived_pinned_updated_idx").on(
      table.spaceId,
      table.userId,
      table.archivedAt,
      table.pinned,
      table.updatedAt,
    ),
    // A blank model id is not a selection; the resolver filters on null, so an
    // empty string would otherwise be returned and sent to a provider as the
    // model. The connection's `default_model` carries the same check.
    check("bot_model_check", sql`${table.model} is null or length(btrim(${table.model})) > 0`),
    // A blank provider kind is not a selection either; null means "the
    // deployment's default".
    check(
      "bot_computer_provider_check",
      sql`${table.computerProvider} is null or length(btrim(${table.computerProvider})) > 0`,
    ),
  ],
);
