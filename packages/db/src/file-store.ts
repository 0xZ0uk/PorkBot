import { NotFoundError } from "@porkbot/effect";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { messageAttachmentColumns, runArtifactColumns } from "./records.ts";
import type { MessageAttachmentRecord, RunArtifactRecord } from "./records.ts";
import { requiredRow } from "./rows.ts";

/**
 * The stored-file store (slice 7.6): the one module that reads or writes
 * `message_attachment` and `run_artifact`, and the only shipped source that
 * names either table. The deployment's bytes live in the storage seam; these
 * are the space's indexes of them, and every read and write binds the actor's
 * `space_id`, so a file in another space and a file that does not exist are
 * the same `NotFoundError`.
 *
 * Two tables exist because the two files enter the space differently, and the
 * schema rules say so: an artifact is idempotent on `(run_id, call_id)`, which
 * a unique index over nullable columns could not enforce, and an attachment
 * exists before the run it will feed, so it has no run to name. Two halves of
 * the seam follow the two callers:
 *
 *   - **The operator's half** (`createFileStore`, a `UserActor`) uploads an
 *     attachment for a thread, resolves the attachments a send references, and
 *     resolves either kind by id for a download. An attachment's bot and user
 *     come from the thread row, never from the caller.
 *   - **The run's half** (`createRunFileStore`, a `SystemActor`) reads the
 *     attachments a message references so the worker can materialize them, and
 *     records an artifact against the run and the durable tool call that
 *     produced it. The run's thread, bot and user come from the run row.
 *
 * A file row is always written after its object, so the failure window leaves
 * an unreferenced object rather than a row whose bytes are missing.
 */

/** An upload's row: the bytes are already in the storage seam at `storageKey`. */
export interface NewAttachment {
  readonly threadId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
}

/** An artifact produced by one settled tool call. */
export interface NewArtifact {
  readonly runId: string;
  readonly callId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
}

/** What a download needs from either kind of row, without its links. */
export interface StoredFile {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
}

/** The operator's half: upload for a thread, then read by id or by send. */
export interface FileStore {
  createAttachment(input: NewAttachment): Promise<MessageAttachmentRecord>;
  /** The attachment rows a send references, in the order the ids were given. */
  findAttachments(
    threadId: string,
    ids: readonly string[],
  ): Promise<readonly MessageAttachmentRecord[]>;
  /**
   * The file an id addresses in the actor's space, of either kind. Absent or
   * foreign is `NotFoundError`; the attachment table is read first, and only a
   * miss there reaches the artifact table.
   */
  findStoredFile(id: string): Promise<StoredFile>;
}

/** The run's half: read a message's attachments, record a tool's artifact. */
export interface RunFileStore {
  findAttachments(
    threadId: string,
    ids: readonly string[],
  ): Promise<readonly MessageAttachmentRecord[]>;
  recordArtifact(input: NewArtifact): Promise<RunArtifactRecord>;
}

export function createFileStore(actor: UserActor, database: Queryable): FileStore {
  return {
    async createAttachment(input): Promise<MessageAttachmentRecord> {
      const { rows } = await database.query<MessageAttachmentRecord>(
        "insert into message_attachment (space_id, thread_id, bot_id, user_id, filename, content_type, size_bytes, storage_key) " +
          "select $1, t.id, t.bot_id, $2, $3, $4, $5, $6 " +
          "from thread t where t.id = $7 and t.space_id = $1 " +
          `returning ${messageAttachmentColumns}`,
        [
          actor.spaceId,
          actor.userId,
          input.filename,
          input.contentType,
          input.sizeBytes,
          input.storageKey,
          input.threadId,
        ],
      );

      const row = rows[0];

      if (row === undefined) {
        throw new NotFoundError("thread", input.threadId);
      }

      return row;
    },

    findAttachments: (threadId, ids) => readAttachments(database, actor.spaceId, threadId, ids),

    async findStoredFile(id): Promise<StoredFile> {
      // Two statements rather than one union: each table's read stays a literal
      // the reviewer can match against the schema, and the attachment table is
      // the common case. Only a miss there reaches the artifact table.
      const { rows: attachments } = await database.query<StoredFile>(
        'select id, filename, content_type as "contentType", size_bytes as "sizeBytes", ' +
          'storage_key as "storageKey" from message_attachment where id = $1 and space_id = $2',
        [id, actor.spaceId],
      );

      const attachment = attachments[0];

      if (attachment !== undefined) {
        return attachment;
      }

      const { rows: artifacts } = await database.query<StoredFile>(
        'select id, filename, content_type as "contentType", size_bytes as "sizeBytes", ' +
          'storage_key as "storageKey" from run_artifact where id = $1 and space_id = $2',
        [id, actor.spaceId],
      );

      return requiredRow(artifacts, "file", id);
    },
  };
}

export function createRunFileStore(actor: SystemActor, database: Queryable): RunFileStore {
  return {
    findAttachments: (threadId, ids) => readAttachments(database, actor.spaceId, threadId, ids),

    async recordArtifact(input): Promise<RunArtifactRecord> {
      const { rows } = await database.query<RunArtifactRecord>(
        "insert into run_artifact (space_id, thread_id, bot_id, user_id, run_id, call_id, filename, content_type, size_bytes, storage_key) " +
          "select $1, r.thread_id, r.bot_id, r.user_id, r.id, $2, $3, $4, $5, $6 " +
          "from run r where r.id = $7 and r.space_id = $1 " +
          "on conflict (run_id, call_id) do nothing " +
          `returning ${runArtifactColumns}`,
        [
          actor.spaceId,
          input.callId,
          input.filename,
          input.contentType,
          input.sizeBytes,
          input.storageKey,
          input.runId,
        ],
      );

      const inserted = rows[0];

      if (inserted !== undefined) {
        return inserted;
      }

      // The conflict was resolved at the index: the call already recorded an
      // artifact. Reading it back answers the retry with the first row instead
      // of failing, and a call outside the job's space is the shared not-found.
      const { rows: existing } = await database.query<RunArtifactRecord>(
        `select ${runArtifactColumns} from run_artifact ` +
          "where space_id = $1 and run_id = $2 and call_id = $3",
        [actor.spaceId, input.runId, input.callId],
      );

      return requiredRow(existing, "run", input.runId);
    },
  };
}

/**
 * The attachments a thread's send references. The thread predicate is part of
 * the read, so a file on another thread and a file in another space are the
 * same not-found; the result preserves the caller's order so a message's
 * blocks and its rows line up.
 */
async function readAttachments(
  database: Queryable,
  spaceId: string,
  threadId: string,
  ids: readonly string[],
): Promise<readonly MessageAttachmentRecord[]> {
  if (ids.length === 0) {
    return [];
  }

  const { rows } = await database.query<MessageAttachmentRecord>(
    `select ${messageAttachmentColumns} from message_attachment ` +
      "where space_id = $1 and thread_id = $2 and id = any($3::uuid[]) " +
      "order by array_position($3::uuid[], id)",
    [spaceId, threadId, ids],
  );

  if (rows.length !== new Set(ids).size) {
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.find((id) => !found.has(id)) ?? ids[0] ?? "";

    throw new NotFoundError("attachment", missing);
  }

  return rows;
}
