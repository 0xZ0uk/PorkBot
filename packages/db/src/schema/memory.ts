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
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { memoryKind, memoryWriteOrigin } from "./enums.ts";
import { space } from "./tenancy.ts";

/**
 * Durable memory documents and their revisions (slice 8.1, PRD decision 21).
 *
 * The document row is the live state the product reads; the revision rows are
 * the history the operator audits. A change is one atomic statement that both
 * advances `memory_document.revision` and appends the matching `memory_revision`
 * row — each statement is a CTE whose update feeds the insert — so a change and
 * its "who and why" cannot come apart, and a crash between the two writes is not
 * a state the schema can reach.
 *
 * `(bot_id, document_id)` is unique over the document's whole life, tombstone
 * included: the domain mints a document id once and never reuses it, so a
 * deleted document keeps its row and its spent id, and a create that targets
 * one collides instead of restarting history. `deleted_at` is the tombstone
 * marker; live reads filter it out, and the row stays so the id stays spent.
 *
 * `memory_revision` is append-only: `(bot_id, document_id, revision)` is unique,
 * so allocating the same revision twice is a database error rather than a
 * silent overwrite, and the tombstone revision keeps the last title and content
 * so a deletion is listed and restorable rather than a gap. There is no
 * foreign key to `memory_document`: the document row survives a deletion
 * precisely so this history does, and the store is the one writer of both.
 */
export const memoryDocument = pgTable(
  "memory_document",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    documentId: text("document_id").notNull(),
    kind: memoryKind("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    revision: integer("revision").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("memory_document_bot_document_unique").on(table.botId, table.documentId),
    index("memory_document_space_bot_live_idx").on(table.spaceId, table.botId, table.deletedAt),
    check("memory_document_revision_check", sql`${table.revision} >= 1`),
    check(
      "memory_document_content_check",
      sql`length(btrim(${table.title})) > 0 and length(btrim(${table.content})) > 0`,
    ),
  ],
);

export const memoryRevision = pgTable(
  "memory_revision",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    documentId: text("document_id").notNull(),
    revision: integer("revision").notNull(),
    origin: memoryWriteOrigin("origin").notNull(),
    author: text("author").notNull(),
    reason: text("reason").notNull(),
    kind: memoryKind("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    deleted: boolean("deleted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_revision_bot_document_revision_unique").on(
      table.botId,
      table.documentId,
      table.revision,
    ),
    index("memory_revision_space_id_idx").on(table.spaceId),
    check("memory_revision_revision_check", sql`${table.revision} >= 1`),
    check(
      "memory_revision_record_check",
      sql`length(btrim(${table.author})) > 0 and length(btrim(${table.reason})) > 0`,
    ),
  ],
);
