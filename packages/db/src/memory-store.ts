import type {
  MemoryDocument,
  MemoryKind,
  MemoryRevision,
  MemoryWrite,
  MemoryWriteOrigin,
} from "@porkbot/core";
import {
  decideMemoryRestore,
  decideMemoryWrite,
  MemoryDocumentExists,
  UnknownMemoryDocument,
  UnknownMemoryRevision,
} from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import type {
  MemoryDocumentRecord,
  MemoryDocuments,
  MemoryProposals,
  MemoryRevisionRecord,
  MemoryWriteInput,
  MemoryWriteOutcome,
} from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The durable half of memory (slice 8.1, PRD decision 21), over the
 * `memory_document` and `memory_revision` tables.
 *
 * This is the one module that names the memory rows. Every other package
 * reaches them through the `MemoryStore` seam in `@porkbot/effect`, and
 * `memory-store.call-sites.test.ts` walks the shipped source and fails when a
 * table name appears anywhere else, so "reads and writes go through one module
 * so both are auditable" is checked rather than promised.
 *
 * The factory splits by actor as the approval store and the repositories do.
 * A `UserActor` gets the operator's half: live and deleted reads, revision
 * history, a deliberate write, and a restore of any recorded revision recorded
 * with the user as author. A `SystemActor` gets the run's half: reads and an
 * agent proposal recorded as `agent_proposed` with the bot as author, so the
 * deletion and the restore the rules refuse can never be forged by choosing the
 * other factory. Origin and author are bound here and never accepted from the
 * caller.
 *
 * Each write is one statement. A CTE inserts or updates the live row and feeds
 * the revision insert from what that row returned, so the change and its "who
 * and why" commit together: the revision's number is the one the document row
 * actually allocated, not the one the pre-read guessed, and a crash between two
 * statements is not a reachable state. The pre-read exists only to give
 * `decideMemoryWrite` (or `decideMemoryRestore`) its context; the database's
 * constraints remain the authority on which concurrent write wins, and the
 * loser's guarded statement matches no row and persists nothing. A restore is
 * the same shape with the target revision read inside the statement, and it
 * clears the tombstone a deletion set, which is how a removed document comes
 * back under the identity its history belongs to.
 */
export function createMemoryStore(actor: UserActor, database: Queryable): MemoryDocuments;
export function createMemoryStore(actor: SystemActor, database: Queryable): MemoryProposals;
export function createMemoryStore(
  actor: Actor,
  database: Queryable,
): MemoryDocuments | MemoryProposals;
export function createMemoryStore(
  actor: Actor,
  database: Queryable,
): MemoryDocuments | MemoryProposals {
  const list = (botId: string) => listDocuments(database, actor.spaceId, botId);
  const find = (botId: string, documentId: string) =>
    findDocument(database, actor.spaceId, botId, documentId);

  if (actor.kind === "system") {
    return {
      list,
      find,
      propose: (botId, input) =>
        applyWrite({
          database,
          spaceId: actor.spaceId,
          botId,
          origin: "agent_proposed",
          author: botId,
          input,
        }),
    };
  }

  return {
    list,
    find,
    listDeleted: (botId) => listDeletedDocuments(database, actor.spaceId, botId),
    revisions: (botId, documentId) => listRevisions(database, actor.spaceId, botId, documentId),
    write: (botId, input) =>
      applyWrite({
        database,
        spaceId: actor.spaceId,
        botId,
        origin: "deliberate",
        author: actor.userId,
        input,
      }),
    restore: (botId, documentId, revision, reason) =>
      restoreRevision(database, {
        spaceId: actor.spaceId,
        botId,
        documentId,
        revision,
        origin: "deliberate",
        author: actor.userId,
        reason,
      }),
  };
}

/**
 * The projections the seam's records are read through. `kind` and `origin` are
 * cast to their core string unions below: the columns are Postgres enums built
 * from `@porkbot/core`'s constants, so the database cannot hold a value the
 * cast does not name. The deleted list and the history add the columns those
 * records carry: the tombstone instant and the change instant.
 */
const documentColumns =
  'document_id as "documentId", kind::text as "kind", title, content, revision';
const documentRecordColumns = `${documentColumns}, deleted_at as "deletedAt"`;
const revisionColumns = `${documentColumns}, origin::text as "origin", author, reason, deleted, created_at as "createdAt"`;

interface DocumentRow {
  readonly documentId: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly revision: number;
}

interface DocumentRecordRow extends DocumentRow {
  /** NULL while the document is live; a tombstone instant once it is not. */
  readonly deletedAt: Date | null;
}

interface RevisionRow extends DocumentRow {
  readonly origin: string;
  readonly author: string;
  readonly reason: string;
  readonly deleted: boolean;
  readonly createdAt: Date;
}

function toDocument(row: DocumentRow): MemoryDocument {
  return {
    documentId: row.documentId,
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    revision: row.revision,
  };
}

function toRevision(row: RevisionRow): MemoryRevision {
  return {
    documentId: row.documentId,
    revision: row.revision,
    origin: row.origin as MemoryWriteOrigin,
    author: row.author,
    reason: row.reason,
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    deleted: row.deleted,
  };
}

function toDocumentRecord(row: DocumentRecordRow): MemoryDocumentRecord {
  return {
    ...toDocument(row),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

function toRevisionRecord(row: RevisionRow): MemoryRevisionRecord {
  return { ...toRevision(row), createdAt: row.createdAt.toISOString() };
}

/**
 * One live document in the actor's space, or `undefined`. A tombstoned row is
 * `undefined` on purpose: the domain never hands a spent id back as a target.
 */
async function findLiveDocument(
  database: Queryable,
  spaceId: string,
  botId: string,
  documentId: string,
): Promise<DocumentRow | undefined> {
  const { rows } = await database.query<DocumentRow>(
    `select ${documentColumns} from memory_document ` +
      "where space_id = $1 and bot_id = $2 and document_id = $3 and deleted_at is null",
    [spaceId, botId, documentId],
  );

  return rows[0];
}

/**
 * One document in the actor's space, tombstone included: the pre-read a
 * restore needs, because reversing a deletion is one of the two things a
 * restore is for.
 */
async function findDocumentRow(
  database: Queryable,
  spaceId: string,
  botId: string,
  documentId: string,
): Promise<DocumentRecordRow | undefined> {
  const { rows } = await database.query<DocumentRecordRow>(
    `select ${documentRecordColumns} from memory_document ` +
      "where space_id = $1 and bot_id = $2 and document_id = $3",
    [spaceId, botId, documentId],
  );

  return rows[0];
}

async function listDocuments(
  database: Queryable,
  spaceId: string,
  botId: string,
): Promise<readonly MemoryDocument[]> {
  const { rows } = await database.query<DocumentRow>(
    `select ${documentColumns} from memory_document ` +
      "where space_id = $1 and bot_id = $2 and deleted_at is null " +
      "order by created_at asc, id asc",
    [spaceId, botId],
  );

  return rows.map(toDocument);
}

/**
 * Tombstoned documents, newest deletion first. The row keeps the last state
 * the deletion recorded, so the operator reads what was removed, and its
 * revision is the tombstone revision a restore names.
 */
async function listDeletedDocuments(
  database: Queryable,
  spaceId: string,
  botId: string,
): Promise<readonly MemoryDocumentRecord[]> {
  const { rows } = await database.query<DocumentRecordRow>(
    `select ${documentRecordColumns} from memory_document ` +
      "where space_id = $1 and bot_id = $2 and deleted_at is not null " +
      "order by deleted_at desc, id desc",
    [spaceId, botId],
  );

  return rows.map(toDocumentRecord);
}

async function findDocument(
  database: Queryable,
  spaceId: string,
  botId: string,
  documentId: string,
): Promise<MemoryDocument> {
  const row = await findLiveDocument(database, spaceId, botId, documentId);

  if (row === undefined) {
    throw new NotFoundError("memory document", documentId);
  }

  return toDocument(row);
}

async function listRevisions(
  database: Queryable,
  spaceId: string,
  botId: string,
  documentId: string,
): Promise<readonly MemoryRevisionRecord[]> {
  const { rows } = await database.query<RevisionRow>(
    `select ${revisionColumns} from memory_revision ` +
      "where space_id = $1 and bot_id = $2 and document_id = $3 " +
      "order by revision asc",
    [spaceId, botId, documentId],
  );

  return rows.map(toRevisionRecord);
}

/** One revision of one document in the actor's space, or `undefined`. */
async function findRevision(
  database: Queryable,
  spaceId: string,
  botId: string,
  documentId: string,
  revision: number,
): Promise<MemoryRevision | undefined> {
  const { rows } = await database.query<RevisionRow>(
    `select ${revisionColumns} from memory_revision ` +
      "where space_id = $1 and bot_id = $2 and document_id = $3 and revision = $4",
    [spaceId, botId, documentId, revision],
  );

  const row = rows[0];

  return row === undefined ? undefined : toRevision(row);
}

async function liveDocumentCount(
  database: Queryable,
  spaceId: string,
  botId: string,
): Promise<number> {
  const { rows } = await database.query<{ readonly count: number }>(
    "select count(*)::int as count from memory_document " +
      "where space_id = $1 and bot_id = $2 and deleted_at is null",
    [spaceId, botId],
  );

  return rows[0]?.count ?? 0;
}

interface WriteOptions {
  readonly database: Queryable;
  readonly spaceId: string;
  readonly botId: string;
  readonly origin: MemoryWriteOrigin;
  readonly author: string;
  readonly input: MemoryWriteInput;
}

/**
 * The whole write path: load the context the rules need, decide, and persist
 * exactly what the decision names. A refused decision and `no_change` return
 * without touching a row.
 *
 * The context read is not a lock. The per-bot document cap is therefore
 * best-effort under concurrency — two racing creates can both see room — while
 * the constraints that matter for correctness are still the database's: a
 * duplicate id collides on the unique index, and the revision number comes from
 * the atomic update rather than this read.
 */
async function applyWrite(options: WriteOptions): Promise<MemoryWriteOutcome> {
  const { database, spaceId, botId, origin, author, input } = options;
  const { write } = input;

  const [existing, documentCount] = await Promise.all([
    findLiveDocument(database, spaceId, botId, write.documentId),
    liveDocumentCount(database, spaceId, botId),
  ]);

  const decision = decideMemoryWrite(
    { origin, author, reason: input.reason, write },
    {
      document: existing === undefined ? undefined : toDocument(existing),
      documentCount,
    },
  );

  if (!decision.ok || decision.action === "no_change") {
    return decision;
  }

  if (write.action === "create") {
    return await createDocument(database, {
      spaceId,
      botId,
      origin,
      author,
      write,
      reason: input.reason,
    });
  }

  if (write.action === "delete") {
    return await tombstoneDocument(database, {
      spaceId,
      botId,
      origin,
      author,
      write,
      reason: input.reason,
    });
  }

  return await reviseDocument(database, {
    spaceId,
    botId,
    origin,
    author,
    write,
    reason: input.reason,
  });
}

type CreateWrite = Extract<MemoryWrite, { readonly action: "create" }>;
type UpdateWrite = Extract<MemoryWrite, { readonly action: "update" }>;
type DeleteWrite = Extract<MemoryWrite, { readonly action: "delete" }>;

interface PersistOptions<Write extends MemoryWrite> {
  readonly spaceId: string;
  readonly botId: string;
  readonly origin: MemoryWriteOrigin;
  readonly author: string;
  readonly write: Write;
  readonly reason: string;
}

/**
 * The create statement: the insert is scoped through the bot row, so a bot in
 * another space inserts nothing, and the conflict clause makes a spent document
 * id — a live row or a tombstone — a no-op rather than a second document.
 */
async function createDocument(
  database: Queryable,
  options: PersistOptions<CreateWrite>,
): Promise<MemoryWriteOutcome> {
  const { spaceId, botId, origin, author, write, reason } = options;

  const { rows } = await database.query<RevisionRow>(
    "with inserted as (" +
      "insert into memory_document (space_id, bot_id, document_id, kind, title, content, revision) " +
      "select $1, b.id, $3, $4::memory_kind, $5, $6, 1 from bot b " +
      "where b.id = $2 and b.space_id = $1 " +
      "on conflict (bot_id, document_id) do nothing " +
      "returning document_id, revision, kind, title, content) " +
      "insert into memory_revision " +
      "(space_id, bot_id, document_id, revision, origin, author, reason, kind, title, content, deleted) " +
      "select $1, $2, i.document_id, i.revision, $7::memory_write_origin, $8, $9, " +
      "i.kind, i.title, i.content, false from inserted i " +
      `returning ${revisionColumns}`,
    [
      spaceId,
      botId,
      write.documentId,
      write.kind,
      write.title,
      write.content,
      origin,
      author,
      reason,
    ],
  );

  const row = rows[0];

  if (row !== undefined) {
    return { ok: true, action: "create", revision: toRevisionRecord(row) };
  }

  // No insert means the bot is not in scope or the id is spent. The scoped bot
  // read tells the two apart without leaking a foreign bot's existence.
  const visible = await botInScope(database, spaceId, botId);

  if (!visible) {
    throw new NotFoundError("bot", botId);
  }

  return { ok: false, error: new MemoryDocumentExists(write.documentId) };
}

/**
 * The update statement allocates the revision atomically from the live row, so
 * two concurrent rewrites cannot land on the same revision number. Its guard
 * matches nothing when another writer tombstoned the document first, and the
 * caller gets the domain's unknown-document answer rather than a lost write.
 */
async function reviseDocument(
  database: Queryable,
  options: PersistOptions<UpdateWrite>,
): Promise<MemoryWriteOutcome> {
  const { spaceId, botId, origin, author, write, reason } = options;

  const { rows } = await database.query<RevisionRow>(
    "with updated as (" +
      "update memory_document set title = $4, content = $5, " +
      "revision = revision + 1, updated_at = now() " +
      "where space_id = $1 and bot_id = $2 and document_id = $3 and deleted_at is null " +
      "returning document_id, revision, kind, title, content) " +
      "insert into memory_revision " +
      "(space_id, bot_id, document_id, revision, origin, author, reason, kind, title, content, deleted) " +
      "select $1, $2, u.document_id, u.revision, $6::memory_write_origin, $7, $8, " +
      "u.kind, u.title, u.content, false from updated u " +
      `returning ${revisionColumns}`,
    [spaceId, botId, write.documentId, write.title, write.content, origin, author, reason],
  );

  const row = rows[0];

  if (row === undefined) {
    return { ok: false, error: new UnknownMemoryDocument(write.documentId) };
  }

  return { ok: true, action: "update", revision: toRevisionRecord(row) };
}

/**
 * The tombstone statement: the live row stays, marked deleted, at the next
 * revision and carrying the last state; the revision row records the deletion
 * itself, so the history has an entry rather than a gap. The spent id remains
 * taken because the document row remains.
 */
async function tombstoneDocument(
  database: Queryable,
  options: PersistOptions<DeleteWrite>,
): Promise<MemoryWriteOutcome> {
  const { spaceId, botId, origin, author, write, reason } = options;

  const { rows } = await database.query<RevisionRow>(
    "with removed as (" +
      "update memory_document set revision = revision + 1, deleted_at = now(), updated_at = now() " +
      "where space_id = $1 and bot_id = $2 and document_id = $3 and deleted_at is null " +
      "returning document_id, revision, kind, title, content) " +
      "insert into memory_revision " +
      "(space_id, bot_id, document_id, revision, origin, author, reason, kind, title, content, deleted) " +
      "select $1, $2, r.document_id, r.revision, $4::memory_write_origin, $5, $6, " +
      "r.kind, r.title, r.content, true from removed r " +
      `returning ${revisionColumns}`,
    [spaceId, botId, write.documentId, origin, author, reason],
  );

  const row = rows[0];

  if (row === undefined) {
    return { ok: false, error: new UnknownMemoryDocument(write.documentId) };
  }

  return { ok: true, action: "delete", revision: toRevisionRecord(row) };
}

async function botInScope(database: Queryable, spaceId: string, botId: string): Promise<boolean> {
  const { rows } = await database.query<{ readonly id: string }>(
    "select id from bot where id = $1 and space_id = $2",
    [botId, spaceId],
  );

  return rows.length > 0;
}

interface RestoreOptions {
  readonly spaceId: string;
  readonly botId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly origin: MemoryWriteOrigin;
  readonly author: string;
  readonly reason: string;
}

/**
 * The restore path: load the document (tombstone included) and the named
 * revision, decide, and persist. The statement reads the target revision again
 * inside the CTE that reapplies it, so the state that lands is the revision's
 * recorded state even if the pre-read is stale, and it clears `deleted_at`,
 * which is how a removed document comes back under the identity its history
 * belongs to rather than as a new document that restarted the story.
 *
 * The pre-read is not a lock: a concurrent write between the read and the
 * statement is overwritten last-writer-wins, exactly as two concurrent updates
 * are. What cannot happen is a persisted revision whose state disagrees with
 * the history it claims to restore — the insert takes its content from the
 * revision row, not from the request.
 */
async function restoreRevision(
  database: Queryable,
  options: RestoreOptions,
): Promise<MemoryWriteOutcome> {
  const { spaceId, botId, documentId, revision, origin, author, reason } = options;

  const [documentRow, target] = await Promise.all([
    findDocumentRow(database, spaceId, botId, documentId),
    findRevision(database, spaceId, botId, documentId, revision),
  ]);

  const decision = decideMemoryRestore(
    { origin, author, reason, documentId, revision },
    {
      document:
        documentRow === undefined
          ? undefined
          : {
              documentId: documentRow.documentId,
              kind: documentRow.kind as MemoryKind,
              title: documentRow.title,
              content: documentRow.content,
              revision: documentRow.revision,
              deleted: documentRow.deletedAt !== null,
            },
      revision: target,
    },
  );

  if (!decision.ok || decision.action === "no_change") {
    return decision;
  }

  const { rows } = await database.query<RevisionRow>(
    "with target as (" +
      "select kind, title, content from memory_revision " +
      "where space_id = $1 and bot_id = $2 and document_id = $3 and revision = $4), " +
      "restored as (" +
      "update memory_document d set kind = t.kind, title = t.title, content = t.content, " +
      "revision = d.revision + 1, deleted_at = null, updated_at = now() " +
      "from target t " +
      "where d.space_id = $1 and d.bot_id = $2 and d.document_id = $3 " +
      "returning d.document_id, d.revision, d.kind, d.title, d.content) " +
      "insert into memory_revision " +
      "(space_id, bot_id, document_id, revision, origin, author, reason, kind, title, content, deleted) " +
      "select $1, $2, r.document_id, r.revision, $5::memory_write_origin, $6, $7, " +
      "r.kind, r.title, r.content, false from restored r " +
      `returning ${revisionColumns}`,
    [spaceId, botId, documentId, revision, origin, author, reason],
  );

  const row = rows[0];

  if (row === undefined) {
    // The pre-read saw the document and the revision, and revisions are
    // append-only, so no row here is the target revision disappearing under a
    // concurrent cascade: the same answer the pre-read would have given.
    return { ok: false, error: new UnknownMemoryRevision(documentId, revision) };
  }

  return { ok: true, action: "restore", revision: toRevisionRecord(row) };
}
