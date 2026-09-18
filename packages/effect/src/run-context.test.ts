import { Effect } from "effect";
import type { MemoryDocument } from "@porkbot/core";
import { DATA_CHANNEL_NOTICE, SYSTEM_SECTION_IDS } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import type { MemoryReader } from "./memory-store.ts";
import { loadRunPrompt } from "./run-context.ts";

class FakeReader implements MemoryReader {
  readonly reads: string[] = [];
  documents: readonly MemoryDocument[] = [];

  list(botId: string): Promise<readonly MemoryDocument[]> {
    this.reads.push(botId);
    return Promise.resolve(this.documents);
  }

  find(): Promise<MemoryDocument> {
    return Promise.reject(new Error("the prompt loader only lists"));
  }
}

const memory: readonly MemoryDocument[] = [
  {
    documentId: "doc-1",
    kind: "fact",
    title: "Timezone",
    content: "The operator is in UTC+1",
    revision: 1,
  },
];

describe("loadRunPrompt", () => {
  it("reads the bot's memory and composes the prompt through the core composer", async () => {
    const reader = new FakeReader();
    reader.documents = memory;

    const run = await Effect.runPromise(
      loadRunPrompt(reader, "bot-1", { bot: { name: "Ada" }, instructions: "Cite sources." }),
    );

    expect(reader.reads).toEqual(["bot-1"]);
    expect(run.prompt.sections.map((section) => section.id)).toEqual([
      SYSTEM_SECTION_IDS.identity,
      SYSTEM_SECTION_IDS.instructions,
      SYSTEM_SECTION_IDS.memory,
    ]);
    expect(
      run.prompt.sections.find((section) => section.id === SYSTEM_SECTION_IDS.memory)?.channel,
    ).toBe("data");
    expect(run.systemPrompt).toContain(DATA_CHANNEL_NOTICE);
    expect(run.systemPrompt).toContain("The operator is in UTC+1");
  });

  it("bounds the memory it injects and reports what was left out", async () => {
    const reader = new FakeReader();
    reader.documents = memory;

    const run = await Effect.runPromise(
      loadRunPrompt(reader, "bot-1", {
        bot: { name: "Ada" },
        limits: {
          maxDocuments: 0,
          maxContentCharacters: 0,
          maxMatches: 0,
          maxExcerptCharacters: 0,
        },
      }),
    );

    expect(run.memory).toEqual({ documents: [], omitted: 1 });
    expect(run.prompt.sections.map((section) => section.id)).toEqual([SYSTEM_SECTION_IDS.identity]);
  });

  it("builds an identity-only prompt for a bot with no visible memory", async () => {
    const reader = new FakeReader();

    const run = await Effect.runPromise(
      loadRunPrompt(reader, "bot-foreign", { bot: { name: "Ada" } }),
    );

    expect(run.systemPrompt).toContain("Ada");
    expect(run.memory).toEqual({ documents: [], omitted: 0 });
  });

  it("fails rather than composing a silently empty prompt when the read breaks", async () => {
    const reader = new FakeReader();
    reader.list = () => Promise.reject(new Error("the store is unreachable"));

    await expect(
      Effect.runPromise(loadRunPrompt(reader, "bot-1", { bot: { name: "Ada" } })),
    ).rejects.toThrow("the store is unreachable");
  });
});
