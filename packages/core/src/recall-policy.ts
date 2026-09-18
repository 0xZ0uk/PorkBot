/**
 * Bounded recall: how much of the memory lane a run may carry.
 *
 * PRD decision 21 makes memory and conversation two lanes. This module bounds
 * the memory lane at both ends it is read from: the documents a run's prompt
 * includes, and the matches a recall tool call hands back. Both are pure
 * selections over data the store already scoped, so the same input always
 * produces the same answer and no caller has to invent a cut-off at the call
 * site — a limit that lives beside the data it bounds cannot drift from the
 * other one that shares its name.
 *
 * A bound is visible, never silent: every selection reports how many records
 * it dropped in `omitted`, so a prompt or a tool result can say memory was
 * truncated instead of pretending the corpus ended. Oversized documents are
 * skipped whole rather than clipped: a fact cut mid-sentence is worse than a
 * fact the operator can tell is missing, and the write rules already cap a
 * document below the prompt budget so a single document always fits.
 */

import type { MemoryDocument } from "./memory-rules.ts";
import type { PromptMemoryDocument } from "./prompt-composition.ts";

export interface RecallLimits {
  /** Most documents one run's prompt memory lane may include. */
  readonly maxDocuments: number;
  /** Most characters of document content the prompt's memory lane may carry. */
  readonly maxContentCharacters: number;
  /** Most matches one recall tool call may return. */
  readonly maxMatches: number;
  /** Most characters of excerpt kept per recalled match. */
  readonly maxExcerptCharacters: number;
}

/**
 * The defaults: eight documents, one maximal document's worth of content, and
 * a match list small enough to read. They bound a prompt without making the
 * common case lossy, and a deployment with a tighter budget passes its own
 * limits through the same function rather than inventing a second cut-off.
 */
export const DEFAULT_RECALL_LIMITS: RecallLimits = {
  maxDocuments: 8,
  maxContentCharacters: 8_192,
  maxMatches: 8,
  maxExcerptCharacters: 240,
};

/** The fields a recall bound needs; a provider match may carry more. */
export interface RecallMatch {
  readonly documentId: string;
  readonly revision: number;
  readonly title: string;
  readonly excerpt: string;
  readonly score: number;
}

export interface BoundedRecall<T extends RecallMatch> {
  /** The matches that survived, in the order the provider ranked them. */
  readonly matches: readonly T[];
  /** How many matches the limits dropped, so an omission is never silent. */
  readonly omitted: number;
}

export interface PromptMemorySelection {
  /** The documents, in input order, with ids and revisions stripped for the prompt. */
  readonly documents: readonly PromptMemoryDocument[];
  /** How many documents the limits dropped, so an omission is never silent. */
  readonly omitted: number;
}

export class RecallLimitError extends Error {
  constructor(field: string, value: unknown) {
    super(`recall limit ${field} must be a non-negative safe integer, received ${String(value)}`);
    this.name = "RecallLimitError";
  }
}

export function assertRecallLimits(limits: RecallLimits): void {
  for (const field of [
    "maxDocuments",
    "maxContentCharacters",
    "maxMatches",
    "maxExcerptCharacters",
  ] as const) {
    const value = limits[field];

    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RecallLimitError(field, value);
    }
  }
}

function clipExcerpt(excerpt: string, maxCharacters: number): string {
  if (excerpt.length <= maxCharacters) {
    return excerpt;
  }

  // A zero-character budget carries nothing, not the truncation marker alone.
  return maxCharacters === 0 ? "" : `${excerpt.slice(0, maxCharacters)}…`;
}

/**
 * Bounds one recall tool's answer: at most `maxMatches` matches, each excerpt
 * clipped to `maxExcerptCharacters`. Extra fields a provider attached (the mode
 * that answered, for instance) ride along untouched, so the bound cannot erase
 * why a hit came back.
 */
export function boundRecallMatches<T extends RecallMatch>(
  matches: readonly T[],
  limits: RecallLimits = DEFAULT_RECALL_LIMITS,
): BoundedRecall<T> {
  assertRecallLimits(limits);

  const kept: T[] = [];

  for (const match of matches.slice(0, limits.maxMatches)) {
    const excerpt = clipExcerpt(match.excerpt, limits.maxExcerptCharacters);
    kept.push(excerpt === match.excerpt ? match : { ...match, excerpt });
  }

  return { matches: kept, omitted: Math.max(0, matches.length - limits.maxMatches) };
}

/**
 * Selects the documents one prompt carries: input order, whole documents only,
 * while both the document count and the content budget allow. A document that
 * does not fit is skipped whole and counted, and a caller that needs a document
 * front and centre orders it first rather than relying on a truncation.
 */
export function selectPromptMemory(
  documents: readonly MemoryDocument[],
  limits: RecallLimits = DEFAULT_RECALL_LIMITS,
): PromptMemorySelection {
  assertRecallLimits(limits);

  const selected: PromptMemoryDocument[] = [];
  let used = 0;
  let omitted = 0;

  for (const document of documents) {
    const cost = document.content.length;

    if (selected.length >= limits.maxDocuments || used + cost > limits.maxContentCharacters) {
      omitted += 1;
      continue;
    }

    selected.push({ kind: document.kind, title: document.title, content: document.content });
    used += cost;
  }

  return { documents: selected, omitted };
}
