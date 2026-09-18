import { Effect } from "effect";
import { COMPACTION_SUMMARY_INSTRUCTIONS } from "@porkbot/core";
import type { ConversationMessage, MemoryDocument } from "@porkbot/core";
import type {
  ModelConnection,
  ModelProbeResult,
  ModelRuntimeProvider,
  ModelStreamEvent,
  ModelTurnRequest,
  ProviderFailure,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { CompactionFailure, createConversationCompactor } from "./conversation-compactor.ts";
import type { MemoryReader } from "./memory-store.ts";

/**
 * The compactor is driven through the provider seams it consumes: a scripted
 * model runtime and a reader that hands back the memory lane. The tests pin the
 * two-lane promise — the summary request carries conversation only, the memory
 * documents come back untouched — and the failure modes that must not be
 * mistaken for a summary.
 */

class FakeReader implements MemoryReader {
  documents: readonly MemoryDocument[] = [];
  readonly reads: string[] = [];

  list(botId: string): Promise<readonly MemoryDocument[]> {
    this.reads.push(botId);
    return Promise.resolve(this.documents);
  }

  find(): Promise<MemoryDocument> {
    return Promise.reject(new Error("the compactor only lists"));
  }
}

class ScriptedFailure extends Error implements ProviderFailure {
  readonly kind: ProviderFailure["kind"];
  readonly detail: string;

  constructor(kind: ProviderFailure["kind"]) {
    super(`scripted ${kind}`);
    this.name = "ScriptedFailure";
    this.kind = kind;
    this.detail = `scripted ${kind}`;
  }
}

class ScriptedRuntime implements ModelRuntimeProvider {
  readonly requests: ModelTurnRequest[] = [];
  events: readonly ModelStreamEvent[] = [];
  failure: ProviderFailure | undefined;
  defect: Error | undefined;

  probe(): Promise<ModelProbeResult> {
    return Promise.resolve({ reachable: true, models: [], streaming: true });
  }

  stream(request: ModelTurnRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const { events, failure, defect } = this;

    return (async function* () {
      if (failure !== undefined) {
        throw failure;
      }

      if (defect !== undefined) {
        throw defect;
      }

      for (const event of events) {
        yield event;
      }
    })();
  }
}

const connection: ModelConnection = {
  baseUrl: "http://127.0.0.1:9/v1",
  credentialName: "offline-test",
};

const memory: readonly MemoryDocument[] = [
  {
    documentId: "doc-1",
    kind: "fact",
    title: "Timezone",
    content: "The operator is in UTC+1",
    revision: 1,
  },
];

function history(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `msg-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message ${index + 1}`,
  }));
}

function setup(options: { keepRecentMessages?: number } = {}) {
  const reader = new FakeReader();
  reader.documents = memory;
  const runtime = new ScriptedRuntime();
  const compactor = createConversationCompactor({
    reader,
    runtime,
    connection,
    model: "fixture-model",
    keepRecentMessages: options.keepRecentMessages ?? 2,
  });

  return { reader, runtime, compactor };
}

describe("createConversationCompactor", () => {
  it("does not call the model when the history fits the keep window", async () => {
    const { runtime, compactor } = setup({ keepRecentMessages: 9 });

    const outcome = await Effect.runPromise(
      compactor.compact({ botId: "bot-1", messages: history(3) }),
    );

    expect(runtime.requests).toHaveLength(0);
    expect(outcome).toEqual({
      summary: null,
      summarisedMessageIds: [],
      keptMessages: history(3),
      memoryDocuments: memory,
    });
  });

  it("summarises the older messages and keeps the newest verbatim", async () => {
    const { reader, runtime, compactor } = setup();
    runtime.events = [
      { type: "text.delta", delta: "The user asked " },
      { type: "text.delta", delta: "for a weekly report." },
      { type: "completed", finishReason: "stop" },
    ];

    const messages = history(5);
    const outcome = await Effect.runPromise(compactor.compact({ botId: "bot-1", messages }));

    expect(outcome.summary).toBe("The user asked for a weekly report.");
    expect(outcome.summarisedMessageIds).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(outcome.keptMessages).toEqual(messages.slice(3));
    expect(outcome.memoryDocuments).toEqual(memory);
    expect(reader.reads).toEqual(["bot-1"]);
    expect(runtime.requests).toEqual([
      {
        connection,
        model: "fixture-model",
        messages: [
          { role: "system", content: COMPACTION_SUMMARY_INSTRUCTIONS },
          {
            role: "user",
            content: ["user: message 1", "assistant: message 2", "user: message 3"].join("\n\n"),
          },
        ],
      },
    ]);
  });

  it("never puts the memory lane into the summariser request", async () => {
    const { runtime, compactor } = setup();
    runtime.events = [
      { type: "text.delta", delta: "summary" },
      { type: "completed", finishReason: "stop" },
    ];

    await Effect.runPromise(compactor.compact({ botId: "bot-1", messages: history(5) }));

    const sent = runtime.requests[0]?.messages ?? [];
    const rendered = sent.map((message) => message.content).join("\n");
    expect(rendered).not.toContain("The operator is in UTC+1");
    expect(rendered).not.toContain("Timezone");
  });

  it("is deterministic for the same history", async () => {
    const first = setup();
    const second = setup();
    const events: readonly ModelStreamEvent[] = [
      { type: "text.delta", delta: "same" },
      { type: "completed", finishReason: "stop" },
    ];
    first.runtime.events = events;
    second.runtime.events = events;

    const firstOutcome = await Effect.runPromise(
      first.compactor.compact({ botId: "bot-1", messages: history(5) }),
    );
    const secondOutcome = await Effect.runPromise(
      second.compactor.compact({ botId: "bot-1", messages: history(5) }),
    );

    expect(firstOutcome).toEqual(secondOutcome);
    expect(first.runtime.requests).toEqual(second.runtime.requests);
  });

  it("propagates a classified provider failure untouched", async () => {
    const { runtime, compactor } = setup();
    runtime.failure = new ScriptedFailure("rate_limited");

    const error = await Effect.runPromise(
      compactor.compact({ botId: "bot-1", messages: history(5) }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({ kind: "rate_limited" });
  });

  it("does not call the model for an empty history", async () => {
    const { runtime, compactor } = setup();

    const outcome = await Effect.runPromise(compactor.compact({ botId: "bot-1", messages: [] }));

    expect(runtime.requests).toHaveLength(0);
    expect(outcome).toEqual({
      summary: null,
      summarisedMessageIds: [],
      keptMessages: [],
      memoryDocuments: memory,
    });
  });

  it("refuses a summary cut off by the model's length limit", async () => {
    const { runtime, compactor } = setup();
    runtime.events = [
      { type: "text.delta", delta: "The user asked about" },
      { type: "completed", finishReason: "length" },
    ];

    const error = await Effect.runPromise(
      compactor.compact({ botId: "bot-1", messages: history(5) }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({ reason: "summary_truncated" });
  });

  it("refuses a completed tool-calls turn even without a call event", async () => {
    const { runtime, compactor } = setup();
    runtime.events = [{ type: "completed", finishReason: "tool_calls" }];

    const error = await Effect.runPromise(
      compactor.compact({ botId: "bot-1", messages: history(5) }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({ reason: "summary_tool_call" });
  });

  it("refuses an empty summary instead of treating it as compacted", async () => {
    const { runtime, compactor } = setup();
    runtime.events = [{ type: "completed", finishReason: "stop" }];

    const error = await Effect.runPromise(
      compactor.compact({ botId: "bot-1", messages: history(5) }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(CompactionFailure);
    expect(error).toMatchObject({ reason: "empty_summary" });
  });

  it("refuses a summariser turn that calls a tool", async () => {
    const { runtime, compactor } = setup();
    runtime.events = [
      { type: "tool.requested", callId: "call-1", name: "remember", arguments: {} },
      { type: "completed", finishReason: "tool_calls" },
    ];

    const error = await Effect.runPromise(
      compactor.compact({ botId: "bot-1", messages: history(5) }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({ reason: "summary_tool_call" });
  });

  it("refuses a stream that ends without completing", async () => {
    const { runtime, compactor } = setup();
    runtime.events = [{ type: "text.delta", delta: "cut off" }];

    const error = await Effect.runPromise(
      compactor.compact({ botId: "bot-1", messages: history(5) }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({ reason: "summary_incomplete" });
  });

  it("dies on an unclassified failure rather than inventing a summary", async () => {
    const { runtime, compactor } = setup();
    runtime.defect = new Error("the provider is broken");

    await expect(
      Effect.runPromise(compactor.compact({ botId: "bot-1", messages: history(5) })),
    ).rejects.toThrow("the provider is broken");
  });
});
