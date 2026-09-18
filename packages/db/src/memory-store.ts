import type {
  MemoryDocument,
  MemoryKind,
  MemoryRevision,
  MemoryWrite,
  MemoryWriteDecision,
  MemoryWriteOrigin,
} from "@porkbot/core";
import { decideMemoryWrite, MemoryDocumentExists, UnknownMemoryDocument } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import type { MemoryDocuments, MemoryProposals, MemoryWriteInput } from "@porkbot/effect";
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
 * A `UserActor` gets the operator's half: reads, revision history, and a
 * deliberate write recorded with the user as author. A `SystemActor` gets the
 * run's half: reads and an agent proposal recorded as `agent_proposed` with the
 * bot as author, so the deletion the rules refuse can never be forged by
 * choosing the other factory. Origin and author are bound here and never
 * accepted from the caller.
 *
 * Each write is one statement. A CTE inserts or updates the live row and feeds
 * the revision insert from what that row returned, so the change and its "who
 * and why" commit together: the revision's number is the one the document row
 * actually allocated, not the one the pre-read guessed, and a crash between two
 * statements is not a reachable state. The pre-read exists only to give
 * `decideMemoryWrite` its context; the database's constraints remain the
 * authority on which concurrent write wins, and the loser's guarded statement
 * matches no row and persists nothing.
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
  };
}

/**
 * The projections the seam's records are read through. `kind` and `origin` are
 * cast to their core string unions below: the columns are Postgres enums built
 * from `@porkbot/core`'s constants, so the database cannot hold a value the
 * cast does not name.
 */
const documentColumns =
  'document_id as "documentId", kind::text as "kind", title, content, revision';
const revisionColumns = `${documentColumns}, origin::text as "origin", author, reason, deleted`;

interface DocumentRow {
  readonly documentId: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly revision: number;
}

interface RevisionRow extends DocumentRow {
  readonly origin: string;
  readonly author: string;
  readonly reason: string;
  readonly deleted: boolean;
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
): Promise<readonly MemoryRevision[]> {
  const { rows } = await database.query<RevisionRow>(
    `select ${revisionColumns} from memory_revision ` +
      "where space_id = $1 and bot_id = $2 and document_id = $3 " +
      "order by revision asc",
    [spaceId, botId, documentId],
  );

  return rows.map(toRevision);
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
async function applyWrite(options: WriteOptions): Promise<MemoryWriteDecision> {
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
): Promise<MemoryWriteDecision> {
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
    return { ok: true, action: "create", revision: toRevision(row) };
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
): Promise<MemoryWriteDecision> {
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

  return { ok: true, action: "update", revision: toRevision(row) };
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
): Promise<MemoryWriteDecision> {
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

  return { ok: true, action: "delete", revision: toRevision(row) };
}

async function botInScope(database: Queryable, spaceId: string, botId: string): Promise<boolean> {
  const { rows } = await database.query<{ readonly id: string }>(
    "select id from bot where id = $1 and space_id = $2",
    [botId, spaceId],
  );

  return rows.length > 0;
}
