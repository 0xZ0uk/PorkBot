import type {
  MemoryDocument,
  MemoryRevision,
  MemoryWrite,
  MemoryWriteDecision,
} from "@porkbot/core";

/**
 * The durable half of memory (slice 8.1, PRD decision 21; stories 23 and 24).
 *
 * Documents and revisions live in Postgres; the memory provider in
 * `@porkbot/adapter-kit` is an index over the document rows, never their
 * source of truth. This seam is the only way shipped code reads or writes
 * those rows: `@porkbot/db` implements it in one module, and a call-site test
 * fails when the table names appear anywhere else, so "reads and writes go
 * through one module" is a check rather than a convention.
 *
 * The factory splits by actor, exactly as the approval gate and the
 * repositories do. A `UserActor` receives `MemoryDocuments`: it may read the
 * history and write as a deliberate operator, and the revision records the
 * user as author. A `SystemActor` receives `MemoryProposals`: it may read what
 * recall needs and propose a create or rewrite, recorded as `agent_proposed`
 * with the bot as author, and the rules refuse an agent deletion without
 * consulting the data. Origin and author are therefore bound at construction,
 * not passed in: a write cannot claim the other path.
 *
 * Every statement behind these methods binds the actor's `space_id` and the
 * requested `bot_id`. A document in another space is not found — the shared
 * `NotFoundError` for a by-id read, an empty list for a listing — and a write
 * aimed at a foreign bot inserts nothing and fails typed.
 *
 * The rules themselves live in `@porkbot/core`'s `decideMemoryWrite`, and the
 * store applies them: it loads the live document and the live count in scope,
 * decides, and persists exactly the revision the decision names. `no_change`
 * persists nothing, which is what keeps a repeated write from growing history.
 * Because each write is one statement whose document update feeds the revision
 * insert, a change and its author/reason cannot come apart even if the process
 * dies mid-write.
 */

/**
 * One write as the caller can express it. Origin and author are not here: they
 * are the actor the store was built from, so a caller cannot choose its path.
 */
export interface MemoryWriteInput {
  readonly write: MemoryWrite;
  /** Why the change happened, recorded on the revision. */
  readonly reason: string;
}

/** The scoped reads both halves share. */
export interface MemoryReader {
  /**
   * Live documents for one bot, oldest first; a tombstoned document is absent.
   * A listing is scoped rather than refused: a bot outside the actor's space
   * yields no rows, exactly like a bot with no documents, so nothing confirms
   * that a foreign bot exists.
   */
  list(botId: string): Promise<readonly MemoryDocument[]>;
  /**
   * One live document. Throws the shared `NotFoundError` when no live document
   * with that id is visible to the actor — a missing row, a tombstone, another
   * bot's document and another space's row are deliberately indistinguishable.
   */
  find(botId: string, documentId: string): Promise<MemoryDocument>;
}

/** The operator's half: revision history and the writes an operator may make. */
export interface MemoryDocuments extends MemoryReader {
  /**
   * Every revision, oldest first, including the tombstone a deletion left, so
   * the operator can read and restore the history rather than infer it. Like
   * `list`, this read is scoped: an unknown or foreign document id yields an
   * empty history rather than an error.
   */
  revisions(botId: string, documentId: string): Promise<readonly MemoryRevision[]>;
  /**
   * Applies `decideMemoryWrite` as a deliberate operator write: create, update
   * or delete, recorded with the user as author. A refused write comes back as
   * `ok: false` carrying the domain error; nothing is persisted for it.
   */
  write(botId: string, input: MemoryWriteInput): Promise<MemoryWriteDecision>;
}

/** The run's half: reads for recall and the proposals an agent may make. */
export interface MemoryProposals extends MemoryReader {
  /**
   * Applies `decideMemoryWrite` as an agent proposal: create or rewrite,
   * recorded as `agent_proposed` with the bot as author. A deletion is refused
   * by the rules — only an operator act removes a durable fact — and comes back
   * as `ok: false`.
   */
  propose(botId: string, input: MemoryWriteInput): Promise<MemoryWriteDecision>;
}
