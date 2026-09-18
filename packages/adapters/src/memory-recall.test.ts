import type {
  MemoryEntry,
  MemoryMatch,
  MemoryProvider,
  MemorySearchRequest,
  ProviderFailure,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { MemoryEmulator, MemoryProviderError, MemoryRecall } from "./index.ts";

/**
 * Recall with a hosted provider configured: the provider answers when it can,
 * and a classified failure degrades to the deterministic lexical index instead
 * of failing the run. The stub records every call, so the tests can prove that
 * a semantic answer never consults lexical, an explicit lexical query never
 * dials out, and an unclassified error is not mistaken for availability.
 */

const match: MemoryMatch = {
  documentId: "doc-1",
  revision: 2,
  title: "Preferred editor",
  excerpt: "keyboard-driven",
  score: 3,
  mode: "semantic",
};

const entry: MemoryEntry = {
  botId: "bot-alpha",
  documentId: "doc-1",
  revision: 2,
  kind: "preference",
  title: "Preferred editor",
  content: "The operator prefers keyboard-driven editing.",
};

class StubProvider implements MemoryProvider {
  readonly indexed: MemoryEntry[][] = [];
  readonly forgotten: string[][] = [];
  readonly searches: MemorySearchRequest[] = [];
  readonly #failure: Error | undefined;
  readonly #matches: readonly MemoryMatch[];

  constructor(
    options: { readonly failure?: Error; readonly matches?: readonly MemoryMatch[] } = {},
  ) {
    this.#failure = options.failure;
    this.#matches = options.matches ?? [match];
  }

  index(entries: readonly MemoryEntry[]): Promise<void> {
    this.indexed.push([...entries]);
    return this.#rejectOrResolve();
  }

  forget(botId: string, documentIds: readonly string[]): Promise<void> {
    this.forgotten.push([botId, ...documentIds]);
    return this.#rejectOrResolve();
  }

  search(request: MemorySearchRequest): Promise<readonly MemoryMatch[]> {
    this.searches.push(request);

    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }

    return Promise.resolve(this.#matches);
  }

  #rejectOrResolve(): Promise<void> {
    return this.#failure === undefined ? Promise.resolve() : Promise.reject(this.#failure);
  }
}

describe("the recall seam", () => {
  it("answers from the semantic provider when it is configured and available", async () => {
    const lexical = new StubProvider({ matches: [{ ...match, mode: "lexical" }] });
    const semantic = new StubProvider();
    const recall = new MemoryRecall({ lexical, semantic });

    const matches = await recall.search({ botId: "bot-alpha", text: "editor", limit: 5 });

    expect(matches).toEqual([match]);
    expect(semantic.searches).toHaveLength(1);
    expect(lexical.searches).toHaveLength(0);
  });

  it("degrades to lexical on a classified provider failure and reports it", async () => {
    const lexical = new MemoryEmulator();
    await lexical.index([entry]);
    const failure = new MemoryProviderError("timed_out", "the provider did not answer");
    const degradations: [ProviderFailure, string][] = [];
    const recall = new MemoryRecall({
      lexical,
      semantic: new StubProvider({ failure }),
      onDegrade: (error, operation) => degradations.push([error, operation]),
    });

    const matches = await recall.search({ botId: "bot-alpha", text: "editor", limit: 5 });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ documentId: "doc-1", mode: "lexical" });
    expect(degradations).toEqual([[failure, "search"]]);
  });

  it("answers lexically with no provider configured, for auto and for semantic", async () => {
    const lexical = new MemoryEmulator();
    await lexical.index([entry]);
    const degradations: unknown[] = [];
    const recall = new MemoryRecall({ lexical, onDegrade: (error) => degradations.push(error) });

    const auto = await recall.search({ botId: "bot-alpha", text: "editor", limit: 5 });
    const wanted = await recall.search({
      botId: "bot-alpha",
      text: "editor",
      limit: 5,
      mode: "semantic",
    });

    expect(auto[0]?.mode).toBe("lexical");
    expect(wanted[0]?.mode).toBe("lexical");
    expect(degradations).toEqual([]);
  });

  it("never dials the provider for an explicit lexical query", async () => {
    const lexical = new StubProvider({ matches: [{ ...match, mode: "lexical" }] });
    const semantic = new StubProvider();
    const recall = new MemoryRecall({ lexical, semantic });

    await recall.search({ botId: "bot-alpha", text: "editor", limit: 5, mode: "lexical" });

    expect(semantic.searches).toHaveLength(0);
    expect(lexical.searches).toHaveLength(1);
  });

  it("indexes and forgets through both indexes, degrading without failing on a classified failure", async () => {
    const lexical = new StubProvider();
    const failure = new MemoryProviderError("auth_failed", "the provider refused the credential");
    const semantic = new StubProvider({ failure });
    const operations: string[] = [];
    const recall = new MemoryRecall({
      lexical,
      semantic,
      onDegrade: (_error, operation) => operations.push(operation),
    });

    await recall.index([entry]);
    await recall.forget("bot-alpha", ["doc-1"]);

    expect(lexical.indexed).toHaveLength(1);
    expect(lexical.forgotten).toHaveLength(1);
    expect(semantic.indexed).toHaveLength(1);
    expect(semantic.forgotten).toHaveLength(1);
    expect(semantic.forgotten[0]).toEqual(["bot-alpha", "doc-1"]);
    expect(operations).toEqual(["index", "forget"]);
  });

  it("does not swallow an unclassified error", async () => {
    const lexical = new MemoryEmulator();
    await lexical.index([entry]);
    const bug = new TypeError("a programming error, not a provider failure");
    const recall = new MemoryRecall({ lexical, semantic: new StubProvider({ failure: bug }) });

    await expect(recall.search({ botId: "bot-alpha", text: "editor", limit: 5 })).rejects.toBe(bug);
    await expect(recall.index([entry])).rejects.toBe(bug);
    await expect(recall.forget("bot-alpha", ["doc-1"])).rejects.toBe(bug);
  });
});
