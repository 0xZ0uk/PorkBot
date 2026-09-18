import { describe, expect, it } from "vitest";
import { MAX_MEMORY_CONTENT_LENGTH } from "./memory-rules.ts";
import type { MemoryDocument } from "./memory-rules.ts";
import {
  assertRecallLimits,
  boundRecallMatches,
  DEFAULT_RECALL_LIMITS,
  RecallLimitError,
  selectPromptMemory,
} from "./recall-policy.ts";
import type { RecallLimits } from "./recall-policy.ts";

const documents: readonly MemoryDocument[] = [
  {
    documentId: "doc-1",
    kind: "fact",
    title: "Timezone",
    content: "The operator is in UTC+1",
    revision: 1,
  },
  {
    documentId: "doc-2",
    kind: "preference",
    title: "Reporting cadence",
    content: "Send the weekly report on Friday",
    revision: 4,
  },
  {
    documentId: "doc-3",
    kind: "decision",
    title: "Supplier",
    content: "Use the workshop supplier",
    revision: 2,
  },
];

function limits(overrides: Partial<RecallLimits> = {}): RecallLimits {
  return { ...DEFAULT_RECALL_LIMITS, ...overrides };
}

describe("selectPromptMemory", () => {
  it("keeps input order and maps documents to the prompt's shape", () => {
    const selection = selectPromptMemory(documents);

    expect(selection.documents).toEqual([
      { kind: "fact", title: "Timezone", content: "The operator is in UTC+1" },
      {
        kind: "preference",
        title: "Reporting cadence",
        content: "Send the weekly report on Friday",
      },
      { kind: "decision", title: "Supplier", content: "Use the workshop supplier" },
    ]);
    expect(selection.omitted).toBe(0);
  });

  it("never carries a document id or revision into the prompt", () => {
    const selection = selectPromptMemory(documents);

    for (const document of selection.documents) {
      expect(Object.keys(document).sort()).toEqual(["content", "kind", "title"]);
    }
  });

  it("counts every document above the count limit as omitted", () => {
    const selection = selectPromptMemory(documents, limits({ maxDocuments: 2 }));

    expect(selection.documents.map((document) => document.title)).toEqual([
      "Timezone",
      "Reporting cadence",
    ]);
    expect(selection.omitted).toBe(1);
  });

  it("skips a document that does not fit the content budget and fills with later ones", () => {
    const selection = selectPromptMemory(documents, limits({ maxContentCharacters: 30 }));

    expect(selection.documents.map((document) => document.title)).toEqual(["Timezone"]);
    expect(selection.omitted).toBe(2);
  });

  it("fits one maximal document inside the default budget", () => {
    const maximal: MemoryDocument = {
      documentId: "doc-max",
      kind: "fact",
      title: "Long",
      content: "x".repeat(MAX_MEMORY_CONTENT_LENGTH),
      revision: 1,
    };

    const selection = selectPromptMemory([maximal]);

    expect(selection.documents).toHaveLength(1);
    expect(selection.omitted).toBe(0);
    expect(DEFAULT_RECALL_LIMITS.maxContentCharacters).toBeGreaterThanOrEqual(
      MAX_MEMORY_CONTENT_LENGTH,
    );
  });

  it("handles an empty document list", () => {
    expect(selectPromptMemory([])).toEqual({ documents: [], omitted: 0 });
  });

  it("is deterministic and does not mutate its input", () => {
    const frozen = Object.freeze(documents.map((document) => Object.freeze(document)));

    expect(selectPromptMemory(frozen)).toEqual(selectPromptMemory(documents));
  });

  it("refuses a limit that is not a non-negative safe integer", () => {
    for (const invalid of [
      { maxDocuments: -1 },
      { maxContentCharacters: 1.5 },
      { maxMatches: Number.NaN },
      { maxExcerptCharacters: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => selectPromptMemory(documents, limits(invalid))).toThrow(RecallLimitError);
    }
  });

  it("treats a zero limit as 'carry nothing', not as 'unlimited'", () => {
    const selection = selectPromptMemory(documents, limits({ maxDocuments: 0 }));

    expect(selection.documents).toEqual([]);
    expect(selection.omitted).toBe(3);
  });
});

describe("boundRecallMatches", () => {
  const matches = [
    { documentId: "doc-1", revision: 1, title: "A", excerpt: "short", score: 3 },
    { documentId: "doc-2", revision: 2, title: "B", excerpt: "y".repeat(30), score: 2 },
    { documentId: "doc-3", revision: 1, title: "C", excerpt: "z", score: 1 },
  ] as const;

  it("returns provider order untouched when everything fits", () => {
    const bounded = boundRecallMatches(matches);

    expect(bounded.matches).toEqual(matches);
    expect(bounded.omitted).toBe(0);
  });

  it("drops matches above the limit and counts them", () => {
    const bounded = boundRecallMatches(matches, limits({ maxMatches: 2 }));

    expect(bounded.matches.map((match) => match.documentId)).toEqual(["doc-1", "doc-2"]);
    expect(bounded.omitted).toBe(1);
  });

  it("clips an excerpt past the character limit and marks the clip", () => {
    const bounded = boundRecallMatches(matches, limits({ maxExcerptCharacters: 10 }));

    expect(bounded.matches[0]?.excerpt).toBe("short");
    expect(bounded.matches[1]?.excerpt).toBe(`${"y".repeat(10)}…`);
    expect(bounded.matches[2]?.excerpt).toBe("z");
  });

  it("carries no excerpt at all when the character limit is zero", () => {
    const bounded = boundRecallMatches(matches, limits({ maxExcerptCharacters: 0 }));

    expect(bounded.matches.map((match) => match.excerpt)).toEqual(["", "", ""]);
  });

  it("keeps fields the provider added, so the bound cannot erase the mode", () => {
    const withMode = matches.map((match) => ({ ...match, mode: "semantic" as const }));
    const bounded = boundRecallMatches(withMode, limits({ maxExcerptCharacters: 4 }));

    expect(bounded.matches[0]).toMatchObject({ mode: "semantic", excerpt: "shor…" });
  });

  it("handles an empty match list", () => {
    expect(boundRecallMatches([])).toEqual({ matches: [], omitted: 0 });
  });

  it("is deterministic and does not mutate its input", () => {
    const frozen = Object.freeze(matches.map((match) => Object.freeze(match)));

    expect(boundRecallMatches(frozen)).toEqual(boundRecallMatches(matches));
    expect(frozen[1]?.excerpt).toBe("y".repeat(30));
  });

  it("refuses a limit that is not a non-negative safe integer", () => {
    expect(() => boundRecallMatches(matches, limits({ maxMatches: -2 }))).toThrow(RecallLimitError);
  });

  it("treats a zero match limit as 'return nothing', not as 'unlimited'", () => {
    const bounded = boundRecallMatches(matches, limits({ maxMatches: 0 }));

    expect(bounded.matches).toEqual([]);
    expect(bounded.omitted).toBe(3);
  });
});

describe("assertRecallLimits", () => {
  it("accepts the defaults and non-negative integers", () => {
    expect(() => assertRecallLimits(DEFAULT_RECALL_LIMITS)).not.toThrow();
    expect(() =>
      assertRecallLimits({
        maxDocuments: 0,
        maxContentCharacters: 0,
        maxMatches: 0,
        maxExcerptCharacters: 0,
      }),
    ).not.toThrow();
  });

  it("names the field it refused", () => {
    try {
      assertRecallLimits(limits({ maxMatches: -1 }));
      throw new Error("expected the limits to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(RecallLimitError);
      expect((error as RecallLimitError).message).toContain("maxMatches");
    }
  });
});
