/**
 * Durable memory documents: what may be written, by which path, and how a
 * write becomes a revision.
 *
 * PRD decision 21 makes memory and conversation two lanes. Facts, preferences
 * and decisions are durable documents that change only through a write, while
 * conversation history is compacted automatically and never becomes a memory
 * document on its own; `compaction-policy.ts` owns that boundary from the
 * other side.
 *
 * Every write arrives with its path attached. A deliberate write is an
 * operator action and may create, rewrite or delete. An agent-proposed write
 * may create or rewrite but never delete, so a durable fact is never lost by a
 * silent agent decision — only an operator removes a document. Every effective
 * write yields exactly one revision carrying who made it and why, which is what
 * makes an agent's change to memory visible instead of silent; a write that
 * changes nothing yields no revision.
 *
 * Restoring is the operator's other act over history. `decideMemoryRestore`
 * reapplies one recorded revision — an earlier rewrite or the tombstone a
 * deletion left — as the document's next revision, so a wrong edit and a wrong
 * deletion are both correctable without restarting the document's identity.
 * Restore is deliberately operator-only: an agent with a revision number could
 * silently discard newer facts, so the seam that exposes it is the operator's
 * half of the store and this rule refuses the proposal path outright.
 *
 * Limits live here so every caller shares one answer and gets a typed error
 * rather than a database constraint message. The rules are pure — the caller
 * mints the document id, looks up the existing document and the count, and the
 * database's constraints remain the authority on which concurrent write wins.
 * Document ids are minted once and never reused: a deleted document keeps its
 * tombstone revision and a new document takes a new id, so history is never
 * restarted under the same identity.
 *
 * `origin` and `author` are recorded, not trusted. Deciding that a caller may
 * write as a deliberate operator rather than an agent proposal, and binding an
 * `agent_proposed` author to the bot, belongs to the authenticated service
 * boundary; this module only makes the consequences of each path explicit.
 */

export const MEMORY_KINDS = ["fact", "preference", "decision"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** How a write reached the rules: an operator edit or an agent proposal. */
export const MEMORY_WRITE_ORIGINS = ["deliberate", "agent_proposed"] as const;

export type MemoryWriteOrigin = (typeof MEMORY_WRITE_ORIGINS)[number];

export const MAX_MEMORY_TITLE_LENGTH = 200;
export const MAX_MEMORY_CONTENT_LENGTH = 8_000;
export const MAX_MEMORY_REASON_LENGTH = 500;
export const MAX_MEMORY_DOCUMENT_ID_LENGTH = 200;
export const MAX_MEMORY_DOCUMENTS_PER_BOT = 200;

/** A durable document as the operator reads it. */
export interface MemoryDocument {
  readonly documentId: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  /**
   * 1 after the first write and one higher per effective write. A document
   * whose only write was a no-op never exists, so this is never 0.
   */
  readonly revision: number;
}

/** One change to a document, kept whole so history can show and restore it. */
export interface MemoryRevision {
  readonly documentId: string;
  readonly revision: number;
  readonly origin: MemoryWriteOrigin;
  /** Who made the change: an operator id or the bot the agent wrote for. */
  readonly author: string;
  /** Why the change happened, as recorded at the time. */
  readonly reason: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  /**
   * True for the revision that removed the document; `title` and `content` are
   * then the last state, so the deletion itself is listed and restorable
   * rather than a gap in the history.
   */
  readonly deleted: boolean;
}

export type MemoryWrite =
  | {
      readonly action: "create";
      /** Minted by the caller, as with every id this package decides about. */
      readonly documentId: string;
      readonly kind: MemoryKind;
      readonly title: string;
      readonly content: string;
    }
  | {
      readonly action: "update";
      readonly documentId: string;
      readonly title: string;
      readonly content: string;
    }
  | {
      readonly action: "delete";
      readonly documentId: string;
    };

export interface MemoryWriteRequest {
  readonly origin: MemoryWriteOrigin;
  readonly author: string;
  readonly reason: string;
  readonly write: MemoryWrite;
}

export interface MemoryWriteContext {
  /**
   * The target of a create, update or delete, loaded while still live; absent
   * means no document holds the write's id. A tombstoned document is never
   * passed — a spent id stays spent.
   */
  readonly document?: MemoryDocument | undefined;
  /** How many live documents the bot already has, checked against the cap. */
  readonly documentCount: number;
}

/**
 * What the caller must do with a write. `create`, `update` and `delete` carry
 * the one revision to persist with the change; `no_change` persists nothing,
 * because repeating a document's current content is not a change and must not
 * grow its revision history.
 */
export type MemoryWriteDecision =
  | {
      readonly ok: true;
      readonly action: "create" | "update" | "delete";
      readonly revision: MemoryRevision;
    }
  | { readonly ok: true; readonly action: "no_change" }
  | { readonly ok: false; readonly error: MemoryRuleError };

/**
 * The document a restore targets, as the store reads it: the live row or a
 * tombstone, because reversing a deletion is one of the two things a restore
 * is for. Absent means no document holds the id at all.
 */
export interface MemoryRestoreTarget {
  readonly documentId: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly revision: number;
  readonly deleted: boolean;
}

/** One restore as the caller can express it: which revision, and why. */
export interface MemoryRestoreRequest {
  readonly origin: MemoryWriteOrigin;
  readonly author: string;
  readonly reason: string;
  readonly documentId: string;
  /** The revision number to reapply, as the document's history holds it. */
  readonly revision: number;
}

export interface MemoryRestoreContext {
  /**
   * The current document, tombstone included; absent means no document holds
   * the id. A restore may target a deleted document — that is how a deletion
   * is undone — so unlike {@link MemoryWriteContext} this is not limited to
   * live rows.
   */
  readonly document?: MemoryRestoreTarget | undefined;
  /**
   * The revision the restore names, loaded from the document's history. Absent
   * or belonging to another document or revision number refuses the write.
   */
  readonly revision?: MemoryRevision | undefined;
}

/**
 * What the caller must do with a restore. `restore` carries the one revision
 * to persist — the target's state as the document's next revision; `no_change`
 * persists nothing because the target already is the document's live state.
 */
export type MemoryRestoreDecision =
  | { readonly ok: true; readonly action: "restore"; readonly revision: MemoryRevision }
  | { readonly ok: true; readonly action: "no_change" }
  | { readonly ok: false; readonly error: MemoryRuleError };

export class MemoryRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRuleError";
  }
}

export class EmptyMemoryTitle extends MemoryRuleError {
  constructor() {
    super("Memory document title must not be blank");
    this.name = "EmptyMemoryTitle";
  }
}

export class MemoryTitleTooLong extends MemoryRuleError {
  readonly length: number;
  readonly maxLength: number;

  constructor(length: number) {
    super(`Memory title is ${length} characters, above the ${MAX_MEMORY_TITLE_LENGTH} limit`);
    this.name = "MemoryTitleTooLong";
    this.length = length;
    this.maxLength = MAX_MEMORY_TITLE_LENGTH;
  }
}

export class EmptyMemoryContent extends MemoryRuleError {
  constructor() {
    super("Memory document content must not be blank");
    this.name = "EmptyMemoryContent";
  }
}

export class MemoryContentTooLong extends MemoryRuleError {
  readonly length: number;
  readonly maxLength: number;

  constructor(length: number) {
    super(`Memory content is ${length} characters, above the ${MAX_MEMORY_CONTENT_LENGTH} limit`);
    this.name = "MemoryContentTooLong";
    this.length = length;
    this.maxLength = MAX_MEMORY_CONTENT_LENGTH;
  }
}

export class MissingMemoryDocumentId extends MemoryRuleError {
  constructor() {
    super("Memory write requires a document id");
    this.name = "MissingMemoryDocumentId";
  }
}

export class MemoryDocumentIdTooLong extends MemoryRuleError {
  readonly length: number;
  readonly maxLength: number;

  constructor(length: number) {
    super(
      `Memory document id is ${length} characters, above the ${MAX_MEMORY_DOCUMENT_ID_LENGTH} limit`,
    );
    this.name = "MemoryDocumentIdTooLong";
    this.length = length;
    this.maxLength = MAX_MEMORY_DOCUMENT_ID_LENGTH;
  }
}

export class MemoryDocumentExists extends MemoryRuleError {
  readonly documentId: string;

  constructor(documentId: string) {
    super(`Memory document "${documentId}" already exists; a rewrite must be an update`);
    this.name = "MemoryDocumentExists";
    this.documentId = documentId;
  }
}

export class MissingMemoryAuthor extends MemoryRuleError {
  constructor() {
    super("Memory write requires an author");
    this.name = "MissingMemoryAuthor";
  }
}

export class MissingMemoryReason extends MemoryRuleError {
  constructor() {
    super("Memory write requires a reason");
    this.name = "MissingMemoryReason";
  }
}

export class MemoryReasonTooLong extends MemoryRuleError {
  readonly length: number;
  readonly maxLength: number;

  constructor(length: number) {
    super(`Memory reason is ${length} characters, above the ${MAX_MEMORY_REASON_LENGTH} limit`);
    this.name = "MemoryReasonTooLong";
    this.length = length;
    this.maxLength = MAX_MEMORY_REASON_LENGTH;
  }
}

export class UnknownMemoryKind extends MemoryRuleError {
  readonly value: unknown;

  constructor(value: unknown) {
    super(`Unknown memory kind: ${String(value)}`);
    this.name = "UnknownMemoryKind";
    this.value = value;
  }
}

export class UnknownMemoryOrigin extends MemoryRuleError {
  readonly value: unknown;

  constructor(value: unknown) {
    super(`Unknown memory write origin: ${String(value)}`);
    this.name = "UnknownMemoryOrigin";
    this.value = value;
  }
}

export class UnknownMemoryAction extends MemoryRuleError {
  readonly value: unknown;

  constructor(value: unknown) {
    super(`Unknown memory write action: ${String(value)}`);
    this.name = "UnknownMemoryAction";
    this.value = value;
  }
}

export class UnknownMemoryDocument extends MemoryRuleError {
  readonly documentId: string;

  constructor(documentId: string) {
    super(`Memory document "${documentId}" does not exist`);
    this.name = "UnknownMemoryDocument";
    this.documentId = documentId;
  }
}

export class AgentCannotDeleteMemory extends MemoryRuleError {
  readonly documentId: string;

  constructor(documentId: string) {
    super(
      `Agent-proposed writes cannot delete memory document "${documentId}"; deletion is an operator act`,
    );
    this.name = "AgentCannotDeleteMemory";
    this.documentId = documentId;
  }
}

export class UnknownMemoryRevision extends MemoryRuleError {
  readonly documentId: string;
  readonly revision: number;

  constructor(documentId: string, revision: number) {
    super(`Memory document "${documentId}" has no revision ${String(revision)}`);
    this.name = "UnknownMemoryRevision";
    this.documentId = documentId;
    this.revision = revision;
  }
}

export class AgentCannotRestoreMemory extends MemoryRuleError {
  readonly documentId: string;

  constructor(documentId: string) {
    super(
      `Agent-proposed writes cannot restore memory document "${documentId}"; history is an operator act`,
    );
    this.name = "AgentCannotRestoreMemory";
    this.documentId = documentId;
  }
}

export class MemoryDocumentLimitReached extends MemoryRuleError {
  readonly count: number;
  readonly limit: number;

  constructor(count: number) {
    super(
      `Bot already has ${count} memory documents, at the ${MAX_MEMORY_DOCUMENTS_PER_BOT} limit`,
    );
    this.name = "MemoryDocumentLimitReached";
    this.count = count;
    this.limit = MAX_MEMORY_DOCUMENTS_PER_BOT;
  }
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isMemoryWriteOrigin(value: unknown): value is MemoryWriteOrigin {
  return typeof value === "string" && (MEMORY_WRITE_ORIGINS as readonly string[]).includes(value);
}

function validateCommon(request: {
  readonly origin: MemoryWriteOrigin;
  readonly author: string;
  readonly reason: string;
}): MemoryRuleError | undefined {
  if (!isMemoryWriteOrigin(request.origin)) {
    return new UnknownMemoryOrigin(request.origin);
  }

  if (typeof request.author !== "string" || request.author.trim().length === 0) {
    return new MissingMemoryAuthor();
  }

  if (typeof request.reason !== "string" || request.reason.trim().length === 0) {
    return new MissingMemoryReason();
  }

  if (request.reason.length > MAX_MEMORY_REASON_LENGTH) {
    return new MemoryReasonTooLong(request.reason.length);
  }

  return undefined;
}

function validateDocumentId(documentId: unknown): MemoryRuleError | undefined {
  if (typeof documentId !== "string" || documentId.trim().length === 0) {
    return new MissingMemoryDocumentId();
  }

  if (documentId.length > MAX_MEMORY_DOCUMENT_ID_LENGTH) {
    return new MemoryDocumentIdTooLong(documentId.length);
  }

  return undefined;
}

function validateContent(title: unknown, content: unknown): MemoryRuleError | undefined {
  if (typeof title !== "string" || title.trim().length === 0) {
    return new EmptyMemoryTitle();
  }

  if (title.length > MAX_MEMORY_TITLE_LENGTH) {
    return new MemoryTitleTooLong(title.length);
  }

  if (typeof content !== "string" || content.trim().length === 0) {
    return new EmptyMemoryContent();
  }

  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    return new MemoryContentTooLong(content.length);
  }

  return undefined;
}

function validateWrite(write: MemoryWrite): MemoryRuleError | undefined {
  switch (write.action) {
    case "create": {
      if (!isMemoryKind(write.kind)) {
        return new UnknownMemoryKind(write.kind);
      }

      return validateDocumentId(write.documentId) ?? validateContent(write.title, write.content);
    }
    case "update":
      return validateDocumentId(write.documentId) ?? validateContent(write.title, write.content);
    case "delete":
      return validateDocumentId(write.documentId);
    default:
      return new UnknownMemoryAction((write as { readonly action: unknown }).action);
  }
}

function buildRevision(
  documentId: string,
  revision: number,
  request: { readonly origin: MemoryWriteOrigin; readonly author: string; readonly reason: string },
  kind: MemoryKind,
  title: string,
  content: string,
  deleted: boolean,
): MemoryRevision {
  return {
    documentId,
    revision,
    origin: request.origin,
    author: request.author,
    reason: request.reason,
    kind,
    title,
    content,
    deleted,
  };
}

/**
 * Decides one memory write against the context the caller looked up. The path
 * is checked before the target so an agent deletion is refused as a rule, not
 * as a lookup miss, and validation comes first so a malformed request is
 * refused before either the limit or the document matters. An update that
 * repeats the target's exact title and content is `no_change` and records no
 * revision.
 */
export function decideMemoryWrite(
  request: MemoryWriteRequest,
  context: MemoryWriteContext,
): MemoryWriteDecision {
  if (!Number.isSafeInteger(context.documentCount) || context.documentCount < 0) {
    throw new RangeError(
      `documentCount must be a non-negative safe integer, received ${String(context.documentCount)}`,
    );
  }

  const invalid = validateCommon(request) ?? validateWrite(request.write);
  if (invalid !== undefined) {
    return { ok: false, error: invalid };
  }

  const write = request.write;

  if (write.action === "create") {
    if (context.document !== undefined) {
      return { ok: false, error: new MemoryDocumentExists(write.documentId) };
    }

    if (context.documentCount >= MAX_MEMORY_DOCUMENTS_PER_BOT) {
      return { ok: false, error: new MemoryDocumentLimitReached(context.documentCount) };
    }

    return {
      ok: true,
      action: "create",
      revision: buildRevision(
        write.documentId,
        1,
        request,
        write.kind,
        write.title,
        write.content,
        false,
      ),
    };
  }

  if (write.action === "delete" && request.origin === "agent_proposed") {
    return { ok: false, error: new AgentCannotDeleteMemory(write.documentId) };
  }

  const existing = context.document;
  if (existing === undefined) {
    return { ok: false, error: new UnknownMemoryDocument(write.documentId) };
  }

  if (write.action === "delete") {
    return {
      ok: true,
      action: "delete",
      revision: buildRevision(
        write.documentId,
        existing.revision + 1,
        request,
        existing.kind,
        existing.title,
        existing.content,
        true,
      ),
    };
  }

  if (existing.title === write.title && existing.content === write.content) {
    return { ok: true, action: "no_change" };
  }

  return {
    ok: true,
    action: "update",
    revision: buildRevision(
      write.documentId,
      existing.revision + 1,
      request,
      existing.kind,
      write.title,
      write.content,
      false,
    ),
  };
}

function validateRestore(request: MemoryRestoreRequest): MemoryRuleError | undefined {
  const invalid = validateCommon(request) ?? validateDocumentId(request.documentId);

  if (invalid !== undefined) {
    return invalid;
  }

  if (request.origin === "agent_proposed") {
    return new AgentCannotRestoreMemory(request.documentId);
  }

  if (!Number.isSafeInteger(request.revision) || request.revision < 1) {
    return new UnknownMemoryRevision(request.documentId, request.revision);
  }

  return undefined;
}

/**
 * Decides one restore: reapply the named revision as the document's next
 * revision. The path is checked before the target — an agent-proposed restore
 * is refused as a rule, not as a lookup miss — and validation comes first so a
 * malformed request is refused before the document or the history matters. A
 * restore that names the document's own live state is `no_change`, so asking
 * for the current revision twice does not grow history; a restore of the
 * tombstone a deletion left is how a deletion is reversed.
 */
export function decideMemoryRestore(
  request: MemoryRestoreRequest,
  context: MemoryRestoreContext,
): MemoryRestoreDecision {
  const invalid = validateRestore(request);

  if (invalid !== undefined) {
    return { ok: false, error: invalid };
  }

  const document = context.document;

  if (document === undefined) {
    return { ok: false, error: new UnknownMemoryDocument(request.documentId) };
  }

  const revision = context.revision;

  if (
    revision === undefined ||
    revision.documentId !== request.documentId ||
    revision.revision !== request.revision
  ) {
    return { ok: false, error: new UnknownMemoryRevision(request.documentId, request.revision) };
  }

  if (
    !document.deleted &&
    document.kind === revision.kind &&
    document.title === revision.title &&
    document.content === revision.content
  ) {
    return { ok: true, action: "no_change" };
  }

  return {
    ok: true,
    action: "restore",
    revision: buildRevision(
      request.documentId,
      document.revision + 1,
      request,
      revision.kind,
      revision.title,
      revision.content,
      false,
    ),
  };
}
