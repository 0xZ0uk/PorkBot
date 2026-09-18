import type { FailureMapping } from "./failures.ts";

/**
 * The memory retrieval seam (PRD decision 21; stories 23, 24).
 *
 * Durable memory documents — facts, preferences, decisions — live in Postgres
 * with their revisions, and this interface is how they are indexed for recall.
 * The document rows are the source of truth; a provider is an index over them,
 * which is why `index` and `forget` are idempotent and why losing the index
 * costs recall quality, never a document.
 *
 * Two implementations ship (slice 8.1): the offline emulator, a deterministic
 * lexical index the whole product runs on with no provider configured, and one
 * real provider reached by URL and credential name like every other seam. A
 * real provider may add semantic ranking; a query that cannot reach it degrades
 * to lexical matching rather than failing, so no run depends on a hosted
 * vendor to remember something.
 *
 * The domain's memory kind crosses as an opaque string: `@porkbot/core` owns
 * the vocabulary of kinds, and this package does not restate it, so a new kind
 * is a domain change rather than a seam change.
 *
 * Failure mapping: a provider raises an error that implements
 * `ProviderFailure`, classified by the `failureMapping` table below. Recall is
 * best-effort — lifecycle code degrades to lexical search or to the document
 * rows, and never fails a run because an index was unavailable.
 */

/** One document revision as the index sees it; the row in Postgres stays authoritative. */
export interface MemoryEntry {
  readonly botId: string;
  readonly documentId: string;
  readonly revision: number;
  /** The domain's `MemoryKind`, carried opaquely so this package does not restate it. */
  readonly kind: string;
  readonly title: string;
  readonly content: string;
}

export type MemorySearchMode = "lexical" | "semantic" | "auto";

export interface MemorySearchRequest {
  readonly botId: string;
  readonly text: string;
  readonly limit: number;
  /**
   * `auto` prefers semantic ranking when the provider has it and falls back to
   * lexical otherwise; the reply says which mode actually answered.
   */
  readonly mode?: MemorySearchMode;
}

export interface MemoryMatch {
  readonly documentId: string;
  readonly revision: number;
  readonly title: string;
  readonly excerpt: string;
  /** Higher is a better match; comparable only within one reply. */
  readonly score: number;
  /** The mode that produced this hit, so a caller can tell degradation from preference. */
  readonly mode: "lexical" | "semantic";
}

export interface MemoryProvider {
  /** Upsert entries by `(botId, documentId, revision)`; indexing the same revision twice is a no-op. */
  index(entries: readonly MemoryEntry[]): Promise<void>;
  /**
   * Drop a bot's documents from the index; forgetting one that was never
   * indexed succeeds. The bot is part of the key because durable document ids
   * are unique per bot, not globally, so an id alone does not identify a row.
   */
  forget(botId: string, documentIds: readonly string[]): Promise<void>;
  /** Rank live documents for a query. No matches is an empty list, not a failure. */
  search(request: MemorySearchRequest): Promise<readonly MemoryMatch[]>;
}

export const failureMapping: FailureMapping = {
  gone: "Not produced: the provider indexes revisions and owns no per-document resource; losing the backing store classifies as `timed_out` or `auth_failed`.",
  not_found:
    "Not raised: a query with no matches is an empty result, and forgetting an unknown document succeeds; an unknown document id at write time is the domain's `UnknownMemoryDocument`.",
  rate_limited:
    "A configured remote provider refuses queries under a quota (HTTP 429); recall degrades to lexical matching instead of failing the run.",
  timed_out:
    "A slow index or query exceeded its budget; recall degrades to lexical matching rather than failing the run.",
  auth_failed:
    "The configured provider credential is refused; memory degrades to the local path, and the operator sees the failure rather than a silent empty memory.",
};
