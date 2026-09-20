import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import type { MessageRecord, RunRecord } from "@porkbot/db";
import { describe, expect, it } from "vitest";
import { buildRunConversation, ConversationUnavailableError } from "./run-conversation.ts";
import type { ConversationReader } from "./run-conversation.ts";

/**
 * The conversation replay (slice 6.11): message rows carry the operator's
 * turns, the event stream carries the assistant's, and the reducer is the one
 * interpretation of the second — so a rebuilt conversation is what the console
 * showed.
 */

const threadId = "thread-1";
const spaceId = "space-1";

function message(overrides: Partial<MessageRecord> & { readonly id: string }): MessageRecord {
  return {
    threadId,
    seq: 0,
    role: "user",
    blocks: [{ type: "text", text: `said ${overrides.id}` }],
    runId: null,
    clientNonce: overrides.id,
    createdAt: new Date(0),
    ...overrides,
  };
}

function run(id: string): RunRecord {
  return {
    id,
    spaceId,
    botId: "bot-1",
    threadId,
    taskId: `task-${id}`,
    userId: "user-1",
    status: "completed",
    trigger: "message",
    error: null,
    errorCode: null,
    leaseOwner: null,
    leaseFence: 0,
    leaseExpiresAt: null,
    stopRequestedAt: null,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    currentStep: null,
    currentStepTool: null,
    stalledAt: null,
    notifiedAt: null,
    checkpoint: {},
    clientNonce: `nonce-${id}`,
    sourceMessageId: null,
    startedAt: new Date(0),
    completedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function frame(seq: number, runId: string, event: Record<string, unknown>): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    ...event,
  } as RunEvent;
}

function reader(input: {
  readonly messages: readonly MessageRecord[];
  readonly events: readonly RunEvent[];
  readonly runs: readonly RunRecord[];
}): ConversationReader {
  return {
    messages: {
      async listForThread(_threadId, page) {
        return input.messages.filter((row) => row.seq > page.afterSeq).slice(0, page.limit);
      },
    },
    events: {
      async listAfter(_threadId, afterSeq, limit) {
        return input.events.filter((event) => event.seq > afterSeq).slice(0, limit);
      },
    },
    runs: {
      async listForThread() {
        return input.runs;
      },
    },
  };
}

describe("buildRunConversation", () => {
  it("orders the operator's rows before the assistant's event turns, per run", async () => {
    const conversation = await buildRunConversation(
      reader({
        runs: [run("run-2"), run("run-1")],
        messages: [
          message({ id: "message-1", seq: 0, runId: "run-1" }),
          message({ id: "message-2", seq: 1, runId: "run-2" }),
        ],
        events: [
          frame(1, "run-1", { type: "run.started" }),
          frame(2, "run-1", { type: "token.delta", messageId: "assistant-1", delta: "Hello" }),
          frame(3, "run-1", {
            type: "run.completed",
            messageId: "assistant-1",
          }),
        ],
      }),
      threadId,
      "run-2",
    );

    expect(conversation.prompt).toBe("said message-2");
    expect(conversation.history).toEqual([
      { role: "user", content: "said message-1" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("keeps a steering turn once, and in the run that owner wrote it to", async () => {
    const conversation = await buildRunConversation(
      reader({
        runs: [run("run-2"), run("run-1")],
        messages: [
          message({ id: "message-1", seq: 0, runId: "run-1" }),
          message({ id: "message-steer", seq: 1, runId: "run-1" }),
          message({ id: "message-2", seq: 2, runId: "run-2" }),
        ],
        events: [
          frame(1, "run-1", { type: "run.started" }),
          frame(2, "run-1", { type: "token.delta", messageId: "assistant-1", delta: "Working" }),
          frame(3, "run-1", {
            type: "run.steered",
            messageId: "message-steer",
            text: "said message-steer",
          }),
          frame(4, "run-1", { type: "token.delta", messageId: "assistant-2", delta: "Fixed" }),
          frame(5, "run-1", { type: "run.completed", messageId: "assistant-2" }),
        ],
      }),
      threadId,
      "run-2",
    );

    expect(conversation.prompt).toBe("said message-2");
    expect(conversation.history).toEqual([
      { role: "user", content: "said message-1" },
      { role: "assistant", content: "Working" },
      { role: "user", content: "said message-steer" },
      { role: "assistant", content: "Fixed" },
    ]);
  });

  it("refuses a run with no operator message to answer", async () => {
    await expect(
      buildRunConversation(
        reader({
          runs: [run("run-1")],
          messages: [],
          events: [frame(1, "run-1", { type: "run.started" })],
        }),
        threadId,
        "run-1",
      ),
    ).rejects.toBeInstanceOf(ConversationUnavailableError);
  });

  it("refuses an event stream the reducer cannot interpret", async () => {
    await expect(
      buildRunConversation(
        reader({
          runs: [run("run-1")],
          messages: [message({ id: "message-1", runId: "run-1" })],
          events: [
            frame(1, "run-1", { type: "run.started" }),
            frame(2, "run-1", { type: "token.delta", messageId: "assistant-1", delta: "Hello" }),
            frame(3, "run-1", { type: "run.completed", messageId: "assistant-1" }),
            frame(4, "run-1", { type: "token.delta", messageId: "assistant-1", delta: "Again" }),
          ],
        }),
        threadId,
        "run-1",
      ),
    ).rejects.toBeInstanceOf(ConversationUnavailableError);
  });
});
