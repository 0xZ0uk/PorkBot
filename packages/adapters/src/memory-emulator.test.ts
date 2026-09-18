import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@porkbot/adapter-kit";
import { MemoryEmulator } from "./index.ts";

/**
 * The emulator is product code — the index the whole product runs on with no
 * provider configured — so its tests read like behavior tests: what scores
 * higher, what a revision replay does, and what a forgotten document stops
 * matching. Everything is deterministic, so the assertions can name positions
 * and excerpts without waiting or pattern-matching.
 */

const bot = "bot-alpha";
const otherBot = "bot-beta";

function entry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "documentId">): MemoryEntry {
  return {
    botId: bot,
    revision: 1,
    kind: "fact",
    title: "Preferred editor",
    content: "The operator prefers keyboard-driven editing.",
    ...overrides,
  };
}

describe("the memory emulator", () => {
  it("scores title hits above body hits and orders ties by document id", async () => {
    const emulator = new MemoryEmulator();

    await emulator.index([
      entry({ documentId: "body-hit", title: "Tooling", content: "Neovim is the editor." }),
      entry({ documentId: "title-b", title: "Editor notes", content: "Nothing here." }),
      entry({ documentId: "title-a", title: "Editor preferences", content: "Nothing here." }),
    ]);

    const matches = await emulator.search({ botId: bot, text: "editor", limit: 10 });

    expect(matches.map((match) => match.documentId)).toEqual(["title-a", "title-b", "body-hit"]);
    expect(matches.map((match) => match.score)).toEqual([2, 2, 1]);
    expect(matches.every((match) => match.mode === "lexical")).toBe(true);
  });

  it("keeps only the highest revision and ignores replays and repeated revisions", async () => {
    const emulator = new MemoryEmulator();

    await emulator.index([entry({ documentId: "doc-1", revision: 1, content: "first draft" })]);
    await emulator.index([entry({ documentId: "doc-1", revision: 2, content: "second draft" })]);
    // An out-of-order replay and a repeat of an indexed revision are no-ops.
    await emulator.index([entry({ documentId: "doc-1", revision: 1, content: "first draft" })]);
    await emulator.index([
      entry({ documentId: "doc-1", revision: 2, content: "a different second draft" }),
    ]);

    const [match] = await emulator.search({ botId: bot, text: "draft", limit: 5 });
    expect(match).toMatchObject({ documentId: "doc-1", revision: 2, excerpt: "second draft" });
    expect(emulator.size).toBe(1);
  });

  it("scopes search and forget to one bot, even when ids repeat across bots", async () => {
    const emulator = new MemoryEmulator();

    await emulator.index([
      entry({ documentId: "shared", content: "alpha secret" }),
      entry({ botId: otherBot, documentId: "shared", content: "beta secret" }),
      entry({ documentId: "mine", content: "alpha notes" }),
    ]);

    expect(await emulator.search({ botId: bot, text: "secret", limit: 5 })).toHaveLength(1);
    expect(await emulator.search({ botId: "bot-gamma", text: "secret", limit: 5 })).toEqual([]);

    // Forgetting alpha's "shared" must not touch beta's document with the id.
    await emulator.forget(bot, ["shared", "never-indexed"]);
    expect(emulator.size).toBe(2);
    expect(
      (await emulator.search({ botId: otherBot, text: "secret", limit: 5 }))[0]?.documentId,
    ).toBe("shared");

    await emulator.forget(bot, ["mine"]);
    expect(await emulator.search({ botId: bot, text: "notes", limit: 5 })).toEqual([]);
  });

  it("returns no matches for an empty query, an empty index and a zero limit", async () => {
    const emulator = new MemoryEmulator();

    expect(await emulator.search({ botId: bot, text: "editor", limit: 5 })).toEqual([]);
    await emulator.index([entry({ documentId: "doc-1" })]);

    expect(await emulator.search({ botId: bot, text: "!!!", limit: 5 })).toEqual([]);
    expect(await emulator.search({ botId: bot, text: "editor", limit: 0 })).toEqual([]);
  });

  it("windows a long excerpt around the first hit and keeps short content whole", async () => {
    const emulator = new MemoryEmulator();
    const long = `${"filler ".repeat(40)}remember the milk${" more".repeat(40)}`;

    await emulator.index([
      entry({ documentId: "long", content: long }),
      entry({ documentId: "short", title: "Short", content: "Remember this." }),
    ]);

    const matches = await emulator.search({ botId: bot, text: "remember", limit: 5 });
    const longMatch = matches.find((match) => match.documentId === "long");
    const shortMatch = matches.find((match) => match.documentId === "short");

    expect(longMatch?.excerpt).toContain("remember the milk");
    expect(longMatch?.excerpt.startsWith("…")).toBe(true);
    expect(longMatch?.excerpt.endsWith("…")).toBe(true);
    expect(longMatch?.excerpt.length).toBeLessThanOrEqual(162);
    expect(shortMatch?.excerpt).toBe("Remember this.");
  });

  it("respects the limit and clears on demand", async () => {
    const emulator = new MemoryEmulator();

    await emulator.index(
      Array.from({ length: 5 }, (_, index) =>
        entry({ documentId: `doc-${index}`, content: `note ${index}` }),
      ),
    );

    expect(await emulator.search({ botId: bot, text: "note", limit: 3 })).toHaveLength(3);
    expect(emulator.size).toBe(5);
    emulator.clear();
    expect(emulator.size).toBe(0);
  });
});
