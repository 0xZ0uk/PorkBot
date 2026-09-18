import { Effect } from "effect";
import {
  COMPACTION_SUMMARY_INSTRUCTIONS,
  DATA_CHANNEL_NOTICE,
  decideMemoryWrite,
  SYSTEM_SECTION_IDS,
} from "@porkbot/core";
import type {
  ConversationMessage,
  MemoryDocument,
  MemoryWriteDecision,
  RunPrompt,
} from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import type {
  CompactionOutcome,
  MemoryProposals,
  MemoryWriteInput,
  ToolRegistration,
} from "@porkbot/effect";
import { createConversationCompactor, createMemoryTools, loadRunPrompt } from "@porkbot/effect";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryEmulator, MemoryRecall, ModelEmulator } from "./index.ts";
import type { ModelEmulatorScript } from "./index.ts";

/**
 * Two lanes, one run, no keys: the memory tools, automatic compaction, the
 * recall index and the run's prompt all drive the shipped seams over the
 * emulators. The model emulator speaks the real HTTP/SSE wire contract, so the
 * summary request a deployment would send is the one this test asserts, and
 * the fact written during the conversation is still in the run's prompt after
 * the messages that produced it are gone.
 */

const botId = "0193f0e2-0000-7000-8000-000000000001";
const runId = "0193f0e2-0000-7000-8000-000000000002";
const model = "fixture-model";
const rememberedFact = "The weekly report goes out on Friday.";

const conversation: readonly ConversationMessage[] = [
  { messageId: "msg-1", role: "user", text: "We should keep the weekly report moving." },
  { messageId: "msg-2", role: "assistant", text: "Understood. What cadence works?" },
  { messageId: "msg-3", role: "user", text: "Please remember: send the weekly report on Friday." },
  { messageId: "msg-4", role: "user", text: "Now summarise the backlog." },
  { messageId: "msg-5", role: "assistant", text: "The backlog has three items." },
];

const transcript = [
  "user: We should keep the weekly report moving.",
  "assistant: Understood. What cadence works?",
  "user: Please remember: send the weekly report on Friday.",
].join("\n\n");

const summaryScript: ModelEmulatorScript = {
  models: [model],
  turns: [
    {
      expect: {
        model,
        messages: [
          { role: "system", content: COMPACTION_SUMMARY_INSTRUCTIONS },
          { role: "user", content: transcript },
        ],
      },
      steps: [
        { type: "text", delta: "The operator wants the weekly " },
        { type: "text", delta: "report sent on Friday." },
      ],
      finishReason: "stop",
    },
  ],
};

const openEmulators: ModelEmulator[] = [];

afterEach(async () => {
  await Promise.all(openEmulators.splice(0).map((emulator) => emulator.stop()));
});

async function startEmulator(script: ModelEmulatorScript = summaryScript): Promise<ModelEmulator> {
  const emulator = await ModelEmulator.start(script, globalThis.fetch);
  openEmulators.push(emulator);
  return emulator;
}

/**
 * The memory lane as a durable seam: the write rules decide, a per-bot map
 * stores. Keying by bot makes a wrong bot id observable — the compactor and
 * the prompt loader would read nothing and the scenario's assertions fail —
 * instead of letting an unscoped double hide a scoping bug.
 */
class DurableMemory implements MemoryProposals {
  readonly #byBot = new Map<string, Map<string, MemoryDocument>>();

  documents(botId: string): ReadonlyMap<string, MemoryDocument> {
    return this.#byBot.get(botId) ?? new Map();
  }

  list(botId: string): Promise<readonly MemoryDocument[]> {
    return Promise.resolve([...(this.#byBot.get(botId)?.values() ?? [])]);
  }

  find(botId: string, documentId: string): Promise<MemoryDocument> {
    const document = this.#byBot.get(botId)?.get(documentId);

    return document === undefined
      ? Promise.reject(new NotFoundError("memory document", documentId))
      : Promise.resolve(document);
  }

  propose(botId: string, input: MemoryWriteInput): Promise<MemoryWriteDecision> {
    const documents = this.#byBot.get(botId) ?? new Map<string, MemoryDocument>();
    this.#byBot.set(botId, documents);

    const document = documents.get(input.write.documentId);
    const decision = decideMemoryWrite(
      { origin: "agent_proposed", author: botId, reason: input.reason, write: input.write },
      { document, documentCount: documents.size },
    );

    if (decision.ok && decision.action !== "no_change") {
      const revision = decision.revision;
      documents.set(revision.documentId, {
        documentId: revision.documentId,
        kind: revision.kind,
        title: revision.title,
        content: revision.content,
        revision: revision.revision,
      });
    }

    return Promise.resolve(decision);
  }
}

function findTool(tools: readonly ToolRegistration[], name: string): ToolRegistration {
  const found = tools.find((registration) => registration.name === name);

  if (found === undefined) {
    throw new Error(`unexpected tool name: ${name}`);
  }

  return found;
}

interface Scenario {
  readonly emulator: ModelEmulator;
  readonly documentId: string;
  readonly outcome: CompactionOutcome;
  readonly prompt: RunPrompt;
  readonly recallResult: unknown;
}

async function runScenario(): Promise<Scenario> {
  const emulator = await startEmulator();
  const memory = new DurableMemory();
  const lexical = new MemoryEmulator();
  const recall = new MemoryRecall({ lexical });
  const tools = createMemoryTools({ botId, proposals: memory, recall });

  const remembered = await Effect.runPromise(
    findTool(tools, "remember").execute({
      runId,
      callId: "call-remember-1",
      tool: "remember",
      arguments: {
        kind: "preference",
        title: "Reporting cadence",
        content: rememberedFact,
        reason: "the operator asked me to remember it",
      },
    }),
  );

  if (typeof remembered !== "object" || remembered === null || !("documentId" in remembered)) {
    throw new Error("the remember tool did not return a document id");
  }

  const documentId = (remembered as { documentId: string }).documentId;
  const stored = memory.documents(botId).get(documentId);

  if (stored === undefined) {
    throw new Error("the remember tool did not store a document");
  }

  await lexical.index([
    {
      botId,
      documentId,
      revision: stored.revision,
      kind: stored.kind,
      title: stored.title,
      content: stored.content,
    },
  ]);

  const compactor = createConversationCompactor({
    reader: memory,
    runtime: emulator,
    connection: emulator.connection,
    model,
    keepRecentMessages: 2,
  });

  const outcome = await Effect.runPromise(compactor.compact({ botId, messages: conversation }));

  const prompt = await Effect.runPromise(
    loadRunPrompt(memory, botId, { bot: { name: "Ada" }, instructions: "Cite sources." }),
  );

  const recallResult = await Effect.runPromise(
    findTool(tools, "recall").execute({
      runId,
      callId: "call-recall-1",
      tool: "recall",
      arguments: { query: "weekly report" },
    }),
  );

  return { emulator, documentId, outcome, prompt, recallResult };
}

describe("the two-lane context offline", () => {
  it("keeps a durable fact in the prompt after the conversation that produced it is compacted", async () => {
    const scenario = await runScenario();

    expect(scenario.outcome.summary).toBe("The operator wants the weekly report sent on Friday.");
    expect(scenario.outcome.summarisedMessageIds).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(scenario.outcome.keptMessages.map((message) => message.messageId)).toEqual([
      "msg-4",
      "msg-5",
    ]);
    expect(scenario.outcome.memoryDocuments.map((document) => document.documentId)).toEqual([
      scenario.documentId,
    ]);

    const memorySection = scenario.prompt.prompt.sections.find(
      (section) => section.id === SYSTEM_SECTION_IDS.memory,
    );
    expect(memorySection?.channel).toBe("data");
    expect(memorySection?.body).toContain(DATA_CHANNEL_NOTICE);
    expect(scenario.prompt.systemPrompt).toContain(rememberedFact);
  });

  it("sends the summariser exactly the fixed instruction and the transcript, never memory", async () => {
    const scenario = await runScenario();
    const [request] = scenario.emulator.requests;

    expect(request?.messages).toEqual([
      { role: "system", content: COMPACTION_SUMMARY_INSTRUCTIONS },
      { role: "user", content: transcript },
    ]);
    expect(JSON.stringify(request?.messages)).not.toContain(rememberedFact);
    expect(request?.tools).toEqual([]);
  });

  it("recalls the fact after compaction through the lexical index", async () => {
    const scenario = await runScenario();

    expect(scenario.recallResult).toMatchObject({
      ok: true,
      omitted: 0,
      matches: [expect.objectContaining({ documentId: scenario.documentId })],
    });
  });

  it("is deterministic: the same history produces the same request and the same outcome", async () => {
    const first = await runScenario();
    const second = await runScenario();

    expect(first.outcome).toEqual(second.outcome);
    expect(first.emulator.requests).toEqual(second.emulator.requests);
    expect(first.prompt.systemPrompt).toBe(second.prompt.systemPrompt);
  });
});
