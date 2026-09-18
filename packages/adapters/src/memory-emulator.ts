import type {
  MemoryEntry,
  MemoryMatch,
  MemoryProvider,
  MemorySearchRequest,
} from "@porkbot/adapter-kit";

/**
 * The offline memory index: a deterministic lexical search over the document
 * revisions the store hands it. It is what the whole product runs on with no
 * provider configured, and the fallback every configured provider degrades to,
 * so the emulator is part of the product rather than a test double — its
 * answers are stable enough to assert by position and content.
 *
 * Determinism is the design. The index is an in-memory map keyed by
 * `(botId, documentId)` and holds one revision per document, the highest one
 * indexed: replaying an older revision out of order never regresses a
 * document. `search` tokenizes the query and both text fields into lowercase
 * alphanumeric words, scores a document by distinct query terms — a title hit
 * outranks a body hit — and orders by score with the document id breaking ties,
 * so equal inputs always produce equal output. Tokenization is ASCII
 * alphanumeric on purpose: a locale-aware stemmer would make the emulator's
 * answers depend on the host.
 *
 * `index` and `forget` are idempotent because the interface says so: the
 * document rows in Postgres are the source of truth, and this index is
 * rebuildable from them at any time.
 */

const MAX_EXCERPT_LENGTH = 160;
const EXCERPT_CONTEXT = 40;

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function queryTerms(text: string): readonly string[] {
  return [...new Set(tokenize(text))];
}

/** Distinct query terms: a title hit is worth two, a body hit one. */
function scoreEntry(entry: MemoryEntry, terms: readonly string[]): number {
  const title = new Set(tokenize(entry.title));
  const content = new Set(tokenize(entry.content));
  let score = 0;

  for (const term of terms) {
    if (title.has(term)) {
      score += 2;
    } else if (content.has(term)) {
      score += 1;
    }
  }

  return score;
}

/**
 * The content window around the first query hit, marked with an ellipsis when
 * it does not start or end the content. Short content is returned whole.
 */
function excerptFor(content: string, terms: readonly string[]): string {
  if (content.length <= MAX_EXCERPT_LENGTH) {
    return content;
  }

  const lower = content.toLowerCase();
  let hit = -1;

  for (const term of terms) {
    const at = lower.indexOf(term);

    if (at >= 0 && (hit === -1 || at < hit)) {
      hit = at;
    }
  }

  const start =
    hit === -1
      ? 0
      : Math.min(Math.max(0, hit - EXCERPT_CONTEXT), content.length - MAX_EXCERPT_LENGTH);
  const window = content.slice(start, start + MAX_EXCERPT_LENGTH);

  return `${start > 0 ? "…" : ""}${window}${
    start + MAX_EXCERPT_LENGTH < content.length ? "…" : ""
  }`;
}

export class MemoryEmulator implements MemoryProvider {
  readonly #indexed = new Map<string, MemoryEntry>();

  /** How many document revisions the index holds, one per document. */
  get size(): number {
    return this.#indexed.size;
  }

  /**
   * Upserts revisions; an entry older than or equal to the one already indexed
   * is ignored, so an out-of-order replay cannot undo a newer revision and
   * indexing the same revision twice stays a no-op.
   */
  index(entries: readonly MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      const key = `${entry.botId}\u0000${entry.documentId}`;
      const current = this.#indexed.get(key);

      if (current === undefined || entry.revision > current.revision) {
        this.#indexed.set(key, entry);
      }
    }

    return Promise.resolve();
  }

  /**
   * Drops one bot's indexed documents with any of the ids. The bot is part of
   * the key because durable document ids are unique per bot, not globally.
   */
  forget(botId: string, documentIds: readonly string[]): Promise<void> {
    const wanted = new Set(documentIds);

    for (const [key, entry] of this.#indexed) {
      if (entry.botId === botId && wanted.has(entry.documentId)) {
        this.#indexed.delete(key);
      }
    }

    return Promise.resolve();
  }

  search(request: MemorySearchRequest): Promise<readonly MemoryMatch[]> {
    const limit = Math.max(0, Math.floor(request.limit));
    const terms = queryTerms(request.text);

    if (limit === 0 || terms.length === 0) {
      return Promise.resolve([]);
    }

    const matches: MemoryMatch[] = [];

    for (const entry of this.#indexed.values()) {
      if (entry.botId !== request.botId) {
        continue;
      }

      const score = scoreEntry(entry, terms);

      if (score === 0) {
        continue;
      }

      matches.push({
        documentId: entry.documentId,
        revision: entry.revision,
        title: entry.title,
        excerpt: excerptFor(entry.content, terms),
        score,
        mode: "lexical",
      });
    }

    matches.sort(
      (left, right) => right.score - left.score || (left.documentId < right.documentId ? -1 : 1),
    );

    return Promise.resolve(matches.slice(0, limit));
  }

  /** Empty the index, for a test that wants a clean recall surface. */
  clear(): void {
    this.#indexed.clear();
  }
}
