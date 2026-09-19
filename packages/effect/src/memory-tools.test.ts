import { Effect } from "effect";
import type { MemoryDocument, MemoryKind } from "@porkbot/core";
import { decideMemoryWrite } from "@porkbot/core";
import type { MemoryMatch, MemoryProvider, MemorySearchRequest } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "./errors.ts";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory-tools.ts";
import type { MemoryProposals, MemoryWriteInput, MemoryWriteOutcome } from "./memory-store.ts";
import { createToolDispatcher } from "./tool-dispatcher.ts";
import type {
  ToolCall,
  ToolCallAdmission,
  ToolCallLedger,
  ToolOutcome,
} from "./tool-dispatcher.ts";

/**
 * The agent's memory tools are exercised through the store seam they are given:
 * an in-memory proposals implementation that applies core's real write rules,
 * and a recording recall index. The tool cannot name an origin or an author,
 * cannot delete, and cannot return more than the recall limits allow — those
 * are the facts these tests pin.
 */

class InMemoryProposals implements MemoryProposals {
  readonly documents = new Map<string, MemoryDocument>();
  readonly writes: MemoryWriteInput[] = [];

  async list(): Promise<readonly MemoryDocument[]> {
    return [...this.documents.values()];
  }

  async find(_botId: string, documentId: string): Promise<MemoryDocument> {
    const document = this.documents.get(documentId);

    if (document === undefined) {
      throw new NotFoundError("memory document", documentId);
    }

    return document;
  }

  async propose(botId: string, input: MemoryWriteInput): Promise<MemoryWriteOutcome> {
    this.writes.push(input);

    const document = this.documents.get(input.write.documentId);
    const decision = decideMemoryWrite(
      { origin: "agent_proposed", author: botId, reason: input.reason, write: input.write },
      { document, documentCount: this.documents.size },
    );

    if (decision.ok && decision.action !== "no_change") {
      const revision = decision.revision;
      this.documents.set(revision.documentId, {
        documentId: revision.documentId,
        kind: revision.kind,
        title: revision.title,
        content: revision.content,
        revision: revision.revision,
      });

      return {
        ok: true,
        action: decision.action,
        revision: { ...revision, createdAt: new Date().toISOString() },
      };
    }

    return decision;
  }
}

class RecordingRecall implements MemoryProvider {
  readonly requests: MemorySearchRequest[] = [];
  matches: readonly MemoryMatch[] = [];

  index(): Promise<void> {
    return Promise.resolve();
  }

  forget(): Promise<void> {
    return Promise.resolve();
  }

  search(request: MemorySearchRequest): Promise<readonly MemoryMatch[]> {
    this.requests.push(request);
    return Promise.resolve(this.matches);
  }
}

class MemoryLedger implements ToolCallLedger {
  readonly #outcomes = new Map<string, ToolOutcome>();

  #key(call: ToolCall): string {
    return `${call.runId}\u0000${call.callId}`;
  }

  begin(call: ToolCall): Promise<ToolCallAdmission> {
    const settled = this.#outcomes.get(this.#key(call));

    return Promise.resolve(settled ?? { status: "started" });
  }

  complete(call: ToolCall, result: unknown): Promise<ToolOutcome> {
    const outcome: ToolOutcome = { status: "completed", result };
    this.#outcomes.set(this.#key(call), outcome);
    return Promise.resolve(outcome);
  }

  fail(call: ToolCall, error: string): Promise<ToolOutcome> {
    const outcome: ToolOutcome = { status: "failed", error };
    this.#outcomes.set(this.#key(call), outcome);
    return Promise.resolve(outcome);
  }
}

interface Harness {
  readonly store: InMemoryProposals;
  readonly recall: RecordingRecall;
  readonly tools: ReturnType<typeof createMemoryTools>;
}

function harness(matches: readonly MemoryMatch[] = []): Harness {
  const store = new InMemoryProposals();
  const recall = new RecordingRecall();
  recall.matches = matches;

  return {
    store,
    recall,
    tools: createMemoryTools({ botId: "bot-1", proposals: store, recall }),
  };
}

function tool(registrations: ReturnType<typeof createMemoryTools>, name: string) {
  const found = registrations.find((registration) => registration.name === name);

  if (found === undefined) {
    throw new Error(`unexpected tool name: ${name}`);
  }

  return found;
}

function call(name: string, args: unknown, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    runId: "run-1",
    callId: `call-${name}`,
    tool: name,
    arguments: args,
    ...overrides,
  };
}

async function execute(harnessed: Harness, name: string, args: unknown): Promise<unknown> {
  return Effect.runPromise(tool(harnessed.tools, name).execute(call(name, args)));
}

function rememberArguments(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "fact",
    title: "Reporting cadence",
    content: "Send the weekly report on Friday",
    reason: "the operator said so",
    ...overrides,
  };
}

function document(overrides: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    documentId: "doc-1",
    kind: "fact" as MemoryKind,
    title: "Timezone",
    content: "The operator is in UTC+1",
    revision: 1,
    ...overrides,
  };
}

describe("createMemoryTools registrations", () => {
  it("offers remember, recall and forget, each with a schema and a budget", () => {
    const harnessed = harness();

    expect(harnessed.tools.map((registration) => registration.name)).toEqual([
      MEMORY_TOOL_NAMES.remember,
      MEMORY_TOOL_NAMES.recall,
      MEMORY_TOOL_NAMES.forget,
    ]);

    for (const registration of harnessed.tools) {
      expect(registration.description.length).toBeGreaterThan(0);
      expect(typeof registration.parameters).toBe("object");
      expect(registration.maxDurationMs).toBe(10_000);
    }
  });

  it("refuses a non-positive duration at construction", () => {
    expect(() =>
      createMemoryTools({
        botId: "bot-1",
        proposals: new InMemoryProposals(),
        recall: new RecordingRecall(),
        maxDurationMs: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("remember", () => {
  it("creates a document through the proposal half and reports the revision", async () => {
    const harnessed = harness();

    const result = await execute(harnessed, MEMORY_TOOL_NAMES.remember, rememberArguments());

    expect(result).toMatchObject({ ok: true, action: "create", revision: 1 });
    const documentId = (result as { documentId: string }).documentId;
    expect(documentId.startsWith("memory-")).toBe(true);
    expect(harnessed.store.documents.get(documentId)).toMatchObject({
      kind: "fact",
      title: "Reporting cadence",
      content: "Send the weekly report on Friday",
      revision: 1,
    });
    expect(harnessed.store.writes).toHaveLength(1);
    expect(harnessed.store.writes[0]?.write.action).toBe("create");
  });

  it("rewrites a recalled document when document_id names one", async () => {
    const harnessed = harness();
    harnessed.store.documents.set("doc-1", document());

    const result = await execute(
      harnessed,
      MEMORY_TOOL_NAMES.remember,
      rememberArguments({ document_id: "doc-1", content: "The operator moved to UTC+2" }),
    );

    expect(result).toEqual({
      ok: true,
      action: "update",
      documentId: "doc-1",
      revision: 2,
      kind: "fact",
    });
    expect(harnessed.store.documents.get("doc-1")?.content).toBe("The operator moved to UTC+2");
  });

  it("keeps the stored kind when a rewrite names a different one, and says so", async () => {
    const harnessed = harness();
    harnessed.store.documents.set("doc-1", document());

    const result = await execute(
      harnessed,
      MEMORY_TOOL_NAMES.remember,
      rememberArguments({ document_id: "doc-1", kind: "decision" }),
    );

    expect(result).toMatchObject({ ok: true, action: "update", kind: "fact" });
    expect(harnessed.store.documents.get("doc-1")?.kind).toBe("fact");
  });

  it("reports an unknown document as a refusal instead of creating it", async () => {
    const harnessed = harness();

    const result = await execute(
      harnessed,
      MEMORY_TOOL_NAMES.remember,
      rememberArguments({ document_id: "doc-missing" }),
    );

    expect(result).toMatchObject({ ok: false, reason: "UnknownMemoryDocument" });
    expect(harnessed.store.documents.size).toBe(0);
  });

  it("is idempotent for the same run and call id", async () => {
    const harnessed = harness();
    const first = tool(harnessed.tools, MEMORY_TOOL_NAMES.remember);

    const firstResult = await Effect.runPromise(
      first.execute(call(MEMORY_TOOL_NAMES.remember, rememberArguments())),
    );
    const replay = await Effect.runPromise(
      first.execute(call(MEMORY_TOOL_NAMES.remember, rememberArguments())),
    );

    expect(replay).toMatchObject({ ok: false, reason: "MemoryDocumentExists" });
    expect((replay as { documentId: string }).documentId).toBe(
      (firstResult as { documentId: string }).documentId,
    );
    expect(harnessed.store.documents.size).toBe(1);
  });

  it("reports a repeat of the current content as no_change without a revision", async () => {
    const harnessed = harness();
    harnessed.store.documents.set("doc-1", document());

    const result = await execute(
      harnessed,
      MEMORY_TOOL_NAMES.remember,
      rememberArguments({
        document_id: "doc-1",
        title: "Timezone",
        content: "The operator is in UTC+1",
      }),
    );

    expect(result).toEqual({ ok: true, action: "no_change", documentId: "doc-1" });
    expect(harnessed.store.documents.get("doc-1")?.revision).toBe(1);
  });

  it("refuses malformed arguments without touching the store", async () => {
    const harnessed = harness();

    const withoutKind = { ...rememberArguments() };
    delete withoutKind["kind"];

    for (const args of [
      undefined,
      "not an object",
      rememberArguments({ kind: "planet" }),
      rememberArguments({ title: "  " }),
      rememberArguments({ content: "" }),
      rememberArguments({ reason: "" }),
      rememberArguments({ document_id: 7 }),
      rememberArguments({ document_id: "  " }),
      withoutKind,
    ]) {
      const result = await execute(harnessed, MEMORY_TOOL_NAMES.remember, args);
      expect(result).toMatchObject({ ok: false, reason: "invalid_arguments" });
    }

    expect(harnessed.store.writes).toHaveLength(0);
  });

  it("surfaces a store failure as a failed call rather than a refusal", async () => {
    const harnessed = harness();
    const failure = new Error("the store is unreachable");
    harnessed.store.propose = () => Promise.reject(failure);

    const error = await Effect.runPromise(
      tool(harnessed.tools, MEMORY_TOOL_NAMES.remember)
        .execute(call(MEMORY_TOOL_NAMES.remember, rememberArguments()))
        .pipe(Effect.flip),
    );

    expect(error).toBe(failure);
  });
});

describe("recall", () => {
  const matches: readonly MemoryMatch[] = [
    { documentId: "doc-1", revision: 1, title: "A", excerpt: "alpha", score: 2, mode: "lexical" },
    { documentId: "doc-2", revision: 1, title: "B", excerpt: "beta", score: 1, mode: "lexical" },
  ];

  it("searches the bot's index and returns bounded matches", async () => {
    const harnessed = harness(matches);

    const result = await execute(harnessed, MEMORY_TOOL_NAMES.recall, { query: "alpha" });

    expect(result).toEqual({ ok: true, matches, omitted: 0 });
    expect(harnessed.recall.requests).toEqual([
      { botId: "bot-1", text: "alpha", limit: 8, mode: "auto" },
    ]);
  });

  it("clamps the requested limit and clips the excerpts to the limits", async () => {
    const harnessed = harness(matches);
    const bounded = createMemoryTools({
      botId: "bot-1",
      proposals: harnessed.store,
      recall: harnessed.recall,
      limits: { maxDocuments: 1, maxContentCharacters: 10, maxMatches: 1, maxExcerptCharacters: 3 },
    });
    const recallTool = tool(bounded, MEMORY_TOOL_NAMES.recall);

    const result = await Effect.runPromise(
      recallTool.execute(call(MEMORY_TOOL_NAMES.recall, { query: "alpha", limit: 50 })),
    );

    expect(harnessed.recall.requests[0]?.limit).toBe(1);
    expect(result).toEqual({
      ok: true,
      matches: [{ ...matches[0], excerpt: "alp…" }],
      omitted: 1,
    });
  });

  it("honours a call limit below the policy cap even when the index over-returns", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      documentId: `doc-${index}`,
      revision: 1,
      title: `T${index}`,
      excerpt: "hit",
      score: 8 - index,
      mode: "lexical" as const,
    }));
    const harnessed = harness(many);

    const result = await execute(harnessed, MEMORY_TOOL_NAMES.recall, {
      query: "hit",
      limit: 2,
    });

    expect(harnessed.recall.requests[0]?.limit).toBe(2);
    expect(result).toMatchObject({ ok: true, omitted: 6 });
    expect((result as { matches: readonly unknown[] }).matches).toHaveLength(2);
  });

  it("refuses malformed arguments without searching", async () => {
    const harnessed = harness(matches);

    for (const args of [
      undefined,
      {},
      { query: " " },
      { query: "x", limit: 0 },
      { query: "x", limit: 1.5 },
    ]) {
      const result = await execute(harnessed, MEMORY_TOOL_NAMES.recall, args);
      expect(result).toMatchObject({ ok: false, reason: "invalid_arguments" });
    }

    expect(harnessed.recall.requests).toHaveLength(0);
  });

  it("surfaces an index failure as a failed call rather than an empty result", async () => {
    const harnessed = harness(matches);
    const failure = new Error("the index is unreachable");
    harnessed.recall.search = () => Promise.reject(failure);

    const error = await Effect.runPromise(
      tool(harnessed.tools, MEMORY_TOOL_NAMES.recall)
        .execute(call(MEMORY_TOOL_NAMES.recall, { query: "alpha" }))
        .pipe(Effect.flip),
    );

    expect(error).toBe(failure);
  });
});

describe("forget", () => {
  it("is refused by the rules and deletes nothing", async () => {
    const harnessed = harness();
    harnessed.store.documents.set("doc-1", document());

    const result = await execute(harnessed, MEMORY_TOOL_NAMES.forget, {
      document_id: "doc-1",
      reason: "no longer true",
    });

    expect(result).toMatchObject({ ok: false, reason: "AgentCannotDeleteMemory" });
    expect(harnessed.store.documents.get("doc-1")?.revision).toBe(1);
    expect(harnessed.store.writes).toEqual([
      {
        write: { action: "delete", documentId: "doc-1" },
        reason: "no longer true",
      },
    ]);
  });

  it("refuses malformed arguments", async () => {
    const harnessed = harness();

    for (const args of [undefined, { document_id: "doc-1" }, { document_id: " ", reason: "x" }]) {
      const result = await execute(harnessed, MEMORY_TOOL_NAMES.forget, args);
      expect(result).toMatchObject({ ok: false, reason: "invalid_arguments" });
    }
  });
});

describe("the memory tools through the dispatcher", () => {
  it("dispatches a remember call, replays it, and records one document", async () => {
    const harnessed = harness();
    const dispatcher = createToolDispatcher({
      registrations: harnessed.tools,
      ledger: new MemoryLedger(),
      leaseTtlMs: 60_000,
      heartbeat: Effect.void,
    });

    const rememberCall = {
      runId: "run-1",
      callId: "call-remember-1",
      tool: MEMORY_TOOL_NAMES.remember,
      arguments: rememberArguments(),
    } satisfies ToolCall;

    const first = await Effect.runPromise(dispatcher.execute(rememberCall));
    const replay = await Effect.runPromise(dispatcher.execute(rememberCall));

    expect(first.status).toBe("completed");
    expect(replay).toEqual(first);
    expect(dispatcher.definitions().map((definition) => definition.name)).toEqual([
      MEMORY_TOOL_NAMES.remember,
      MEMORY_TOOL_NAMES.recall,
      MEMORY_TOOL_NAMES.forget,
    ]);
    expect(harnessed.store.documents.size).toBe(1);
  });
});
