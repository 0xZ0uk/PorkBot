import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { user } from "./identity.ts";
import { run } from "./runs.ts";
import { space } from "./tenancy.ts";
import { thread } from "./threads.ts";

/**
 * A file an operator uploaded for a message (slice 7.6, story 32).
 *
 * The bytes live in the storage seam under `storage_key`; this row is the
 * space's index of them, and the worker materializes the bytes into the run's
 * computer before the run starts, at the deterministic home-relative path
 * `attachmentWorkspacePath` gives. The row carries `space_id` like every
 * space-scoped row, and the read paths go through the actor-scoped
 * repositories, so a foreign file id answers the shared `NOT_FOUND`.
 *
 * It is written before the message that references it exists, and the message
 * block carries this row's id, so an upload that is never sent leaves an
 * unreferenced object rather than a message with missing bytes. A bot or
 * thread delete cascades the row; the stored object is reclaimed by the
 * storage sweep the snapshot archives also await, and until then it is
 * unreferenced, never readable.
 *
 * The unique index is deliberately absent: an upload is not idempotent on any
 * caller key, and a retried upload is a second attachment rather than a
 * conflict.
 */
export const messageAttachment = pgTable(
  "message_attachment",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The stored name, already stripped of directories by `attachmentFileName`. */
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    ...timestamps(),
  },
  (table) => [
    index("message_attachment_thread_id_idx").on(table.threadId),
    index("message_attachment_space_id_idx").on(table.spaceId),
    index("message_attachment_bot_id_idx").on(table.botId),
    index("message_attachment_user_id_idx").on(table.userId),
    check("message_attachment_filename_check", sql`length(btrim(${table.filename})) > 0`),
    check("message_attachment_content_type_check", sql`length(btrim(${table.contentType})) > 0`),
    check("message_attachment_size_bytes_check", sql`${table.sizeBytes} >= 0`),
  ],
);

/**
 * A file a tool produced during a run (slice 7.6, story 33).
 *
 * An artifact is the second way a file enters the space: the tool wrote it in
 * the computer, and the platform copied its bytes through the storage seam so
 * it survives the run, the machine's park, and the container's destruction.
 * The row is therefore an index of stored bytes, never a pointer at a
 * filesystem path, and a download resolves the row and then the object — which
 * is what makes "retrievable after the run and after a reload" a property
 * rather than a hope.
 *
 * `(run_id, call_id)` is unique and both columns are NOT NULL, so a retried
 * recording of the same tool call finds the first row instead of inserting a
 * second; the deterministic storage key the recorder writes under means the
 * replayed write also lands on the same object. The run link cascades: a
 * deleted run takes its artifact rows with it, exactly as it takes its ledger
 * rows, and the stored objects are reclaimed by the same storage sweep the
 * snapshot archives await.
 */
export const runArtifact = pgTable(
  "run_artifact",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    /** The durable tool-call id that produced the artifact. */
    callId: text("call_id").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("run_artifact_run_call_unique").on(table.runId, table.callId),
    index("run_artifact_thread_id_idx").on(table.threadId),
    index("run_artifact_space_id_idx").on(table.spaceId),
    index("run_artifact_bot_id_idx").on(table.botId),
    index("run_artifact_user_id_idx").on(table.userId),
    check("run_artifact_call_id_check", sql`length(btrim(${table.callId})) > 0`),
    check("run_artifact_filename_check", sql`length(btrim(${table.filename})) > 0`),
    check("run_artifact_content_type_check", sql`length(btrim(${table.contentType})) > 0`),
    check("run_artifact_size_bytes_check", sql`${table.sizeBytes} >= 0`),
  ],
);
