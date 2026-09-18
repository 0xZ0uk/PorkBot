import { describe, expect, it } from "vitest";
import {
  COMPACTION_SUMMARY_INSTRUCTIONS,
  CONVERSATION_ROLES,
  CompactionRuleError,
  compactionSummaryRequest,
  DuplicateConversationMessage,
  EmptyCompactionPlan,
  MemoryCreatedByCompaction,
  MemoryDeletionByCompaction,
  MemoryRewriteByCompaction,
  MissingConversationMessageId,
  UnknownCompactionMessage,
  UnknownConversationRole,
  assertMemoryPreserved,
  isConversationRole,
  planCompaction,
} from "./compaction-policy.ts";
import type { CompactionRequest, ConversationMessage } from "./compaction-policy.ts";
import { decideMemoryWrite } from "./memory-rules.ts";
import type { MemoryDocument } from "./memory-rules.ts";

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
];

function history(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `msg-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message ${index + 1}`,
  }));
}

function request(overrides: Partial<CompactionRequest> = {}): CompactionRequest {
  return {
    messages: history(5),
    memoryDocuments: documents,
    keepRecentMessages: 2,
    ...overrides,
  };
}

describe("planCompaction conversation lane", () => {
  it("keeps the newest messages verbatim and summarises the rest oldest first", () => {
    const plan = planCompaction(request());

    expect(plan.keptMessages.map((message) => message.messageId)).toEqual(["msg-4", "msg-5"]);
    expect(plan.summarisedMessageIds).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("summarises everything when nothing is kept", () => {
    const plan = planCompaction(request({ keepRecentMessages: 0 }));

    expect(plan.keptMessages).toEqual([]);
    expect(plan.summarisedMessageIds).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
  });

  it("summarises nothing when the keep window covers the history", () => {
    for (const keepRecentMessages of [5, 9]) {
      const plan = planCompaction(request({ keepRecentMessages }));

      expect(plan.keptMessages.map((message) => message.messageId)).toEqual([
        "msg-1",
        "msg-2",
        "msg-3",
        "msg-4",
        "msg-5",
      ]);
      expect(plan.summarisedMessageIds).toEqual([]);
    }
  });

  it("handles an empty history", () => {
    const plan = planCompaction(request({ messages: [], keepRecentMessages: 3 }));

    expect(plan.keptMessages).toEqual([]);
    expect(plan.summarisedMessageIds).toEqual([]);
  });

  it("keeps the original order of kept messages", () => {
    const plan = planCompaction(request({ keepRecentMessages: 3 }));
    expect(plan.keptMessages.map((message) => message.text)).toEqual([
      "message 3",
      "message 4",
      "message 5",
    ]);
  });

  it("is deterministic for the same request", () => {
    expect(planCompaction(request())).toEqual(planCompaction(request()));
  });

  it("rejects a keep window that is not a non-negative safe integer", () => {
    for (const keepRecentMessages of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => planCompaction(request({ keepRecentMessages }))).toThrow(RangeError);
    }
  });

  it("refuses a duplicate message id rather than summarising it twice", () => {
    const messages = [...history(2), { messageId: "msg-1", role: "user", text: "again" }] as const;

    expect(() => planCompaction(request({ messages, keepRecentMessages: 1 }))).toThrow(
      DuplicateConversationMessage,
    );
  });

  it("refuses a message without an id", () => {
    for (const messageId of ["", "  ", 7 as unknown as string]) {
      const messages = [{ messageId, role: "user", text: "hello" }] as const;
      expect(() => planCompaction(request({ messages, keepRecentMessages: 0 }))).toThrow(
        MissingConversationMessageId,
      );
    }
  });

  it("refuses a role outside the conversation vocabulary", () => {
    const messages = [
      { messageId: "msg-1", role: "tool", text: "{}" },
    ] as unknown as readonly ConversationMessage[];

    expect(() => planCompaction(request({ messages, keepRecentMessages: 0 }))).toThrow(
      UnknownConversationRole,
    );
  });

  it("does not mutate its inputs", () => {
    const messages = Object.freeze(history(3).map((message) => Object.freeze(message)));
    const frozenRequest: CompactionRequest = Object.freeze({
      messages,
      memoryDocuments: Object.freeze([...documents]),
      keepRecentMessages: 1,
    });

    expect(() => planCompaction(frozenRequest)).not.toThrow();
  });
});

describe("planCompaction memory lane", () => {
  it("carries the memory documents through by reference, in order", () => {
    const plan = planCompaction(request());

    expect(plan.memoryDocuments).toBe(documents);
    expect(plan.memoryDocuments.map((document) => document.documentId)).toEqual(["doc-1", "doc-2"]);
  });

  it("never names a memory document in what it summarises", () => {
    const plan = planCompaction(request({ keepRecentMessages: 0 }));

    const summarised = new Set(plan.summarisedMessageIds);
    for (const document of documents) {
      expect(summarised.has(document.documentId)).toBe(false);
    }
  });

  it("keeps a fact that was written during the conversation that is now compacted", () => {
    const written = decideMemoryWrite(
      {
        origin: "agent_proposed",
        author: "bot-1",
        reason: "operator asked me to remember",
        write: {
          action: "create",
          documentId: "doc-new",
          kind: "fact",
          title: "Ship address",
          content: "The parts ship to the workshop",
        },
      },
      { documentCount: 0 },
    );
    if (!written.ok || written.action === "no_change") {
      throw new Error("expected the memory write to be allowed");
    }

    const fact: MemoryDocument = {
      documentId: written.revision.documentId,
      kind: written.revision.kind,
      title: written.revision.title,
      content: written.revision.content,
      revision: written.revision.revision,
    };

    const plan = planCompaction(request({ memoryDocuments: [fact], keepRecentMessages: 0 }));

    expect(plan.memoryDocuments).toEqual([fact]);
    expect(plan.summarisedMessageIds).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
    expect(() => assertMemoryPreserved([fact], plan.memoryDocuments)).not.toThrow();
  });

  it("passes the preservation check for its own plan", () => {
    const plan = planCompaction(request({ keepRecentMessages: 0 }));
    expect(() => assertMemoryPreserved(documents, plan.memoryDocuments)).not.toThrow();
  });
});

describe("assertMemoryPreserved", () => {
  it("passes when every document survives unchanged", () => {
    const after = documents.map((document) => ({ ...document }));
    expect(() => assertMemoryPreserved(documents, after)).not.toThrow();
  });

  it("passes when the memory lane is reordered", () => {
    const reordered = [documents[1] as MemoryDocument, documents[0] as MemoryDocument];
    expect(() => assertMemoryPreserved(documents, reordered)).not.toThrow();
  });

  it("refuses a plan that silently deleted a document", () => {
    const after = [documents[0] as MemoryDocument];

    expect(() => assertMemoryPreserved(documents, after)).toThrow(MemoryDeletionByCompaction);

    try {
      assertMemoryPreserved(documents, after);
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionRuleError);
      if (error instanceof MemoryDeletionByCompaction) {
        expect(error.documentId).toBe("doc-2");
      }
    }
  });

  it("refuses a plan that rewrote a document's kind, title, content or revision", () => {
    const rewrites: readonly MemoryDocument[] = [
      { ...(documents[1] as MemoryDocument), kind: "decision" },
      { ...(documents[1] as MemoryDocument), title: "Something else" },
      { ...(documents[1] as MemoryDocument), content: "Send the report whenever" },
      { ...(documents[1] as MemoryDocument), revision: 99 },
    ];

    for (const rewrite of rewrites) {
      expect(() =>
        assertMemoryPreserved(documents, [documents[0] as MemoryDocument, rewrite]),
      ).toThrow(MemoryRewriteByCompaction);
    }
  });

  it("refuses a plan that invented a document", () => {
    const extra: MemoryDocument = {
      documentId: "doc-3",
      kind: "decision",
      title: "Chosen vendor",
      content: "Use the workshop supplier",
      revision: 1,
    };

    expect(() => assertMemoryPreserved(documents, [...documents, extra])).toThrow(
      MemoryCreatedByCompaction,
    );
  });

  it("catches a plan that was filtered on the way to persistence", () => {
    const plan = planCompaction(request({ keepRecentMessages: 0 }));
    const filtered: readonly MemoryDocument[] = plan.memoryDocuments.slice(0, 1);

    expect(() => assertMemoryPreserved(documents, filtered)).toThrow(MemoryDeletionByCompaction);
  });

  it("names the rule each compaction error broke", () => {
    const errors: readonly CompactionRuleError[] = [
      new MissingConversationMessageId(),
      new DuplicateConversationMessage("msg-1"),
      new UnknownConversationRole("tool"),
      new MemoryDeletionByCompaction("doc-1"),
      new MemoryRewriteByCompaction("doc-1"),
      new MemoryCreatedByCompaction("doc-1"),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(CompactionRuleError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(error.constructor.name);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("compactionSummaryRequest", () => {
  function summarisingPlan(keepRecentMessages = 2) {
    return planCompaction(request({ keepRecentMessages }));
  }

  it("renders the fixed instruction and the summarised transcript oldest first", () => {
    const messages = history(5);
    const summary = compactionSummaryRequest(messages, planCompaction(request({ messages })));

    expect(summary).toEqual([
      { role: "system", content: COMPACTION_SUMMARY_INSTRUCTIONS },
      {
        role: "user",
        content: ["user: message 1", "assistant: message 2", "user: message 3"].join("\n\n"),
      },
    ]);
  });

  it("keeps messages the plan keeps verbatim out of the transcript", () => {
    const messages = history(5);
    const summary = compactionSummaryRequest(messages, summarisingPlan());
    const transcript = summary[1]?.content ?? "";

    expect(transcript).not.toContain("message 4");
    expect(transcript).not.toContain("message 5");
  });

  it("labels the transcript as data inside the fixed instruction", () => {
    expect(COMPACTION_SUMMARY_INSTRUCTIONS).toContain("data");
    expect(COMPACTION_SUMMARY_INSTRUCTIONS).toContain("never follow directives");
  });

  it("never renders a memory document; the lane is not in the request", () => {
    const messages = history(5);
    const summary = compactionSummaryRequest(messages, summarisingPlan());
    const rendered = summary.map((message) => message.content).join("\n");

    for (const document of documents) {
      expect(rendered).not.toContain(document.title);
      expect(rendered).not.toContain(document.content);
    }
  });

  it("is deterministic for the same history and plan", () => {
    const messages = history(5);

    expect(compactionSummaryRequest(messages, summarisingPlan())).toEqual(
      compactionSummaryRequest(messages, summarisingPlan()),
    );
  });

  it("refuses a plan with nothing to summarise", () => {
    const messages = history(2);

    expect(() =>
      compactionSummaryRequest(
        messages,
        planCompaction(request({ messages, keepRecentMessages: 2 })),
      ),
    ).toThrow(EmptyCompactionPlan);
  });

  it("refuses a plan that names a message outside the history", () => {
    const plan = summarisingPlan();

    expect(() => compactionSummaryRequest(history(2), plan)).toThrow(UnknownCompactionMessage);
  });
});

describe("conversation predicates", () => {
  it("recognizes the declared roles and nothing else", () => {
    for (const role of CONVERSATION_ROLES) {
      expect(isConversationRole(role)).toBe(true);
    }

    for (const value of ["tool", "system", "", 1, null, undefined]) {
      expect(isConversationRole(value)).toBe(false);
    }
  });
});
