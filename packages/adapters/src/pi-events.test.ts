import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { parseRunEvent, RUN_EVENT_TYPES } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import {
  MalformedPiEvent,
  PI_EVENT_MAPPING,
  PiEventSequenceError,
  PiRunTranslator,
  UnknownPiEventField,
  UnknownPiEventType,
  UnknownPiMessageEventType,
} from "./pi-events.ts";
import type { PiAssistantMessageEventType, PiEventType, PiStopReason } from "./pi-events.ts";

/**
 * The Pi translation table is the boundary (slice 5.3, PRD decision 13). These
 * tests pin the two properties the corpus depends on: every canonical Pi event
 * is classified exactly once, and anything the pinned Pi does not promise —
 * an unknown event, an unknown field, an unknown nested update — is a typed
 * refusal rather than a silently dropped frame.
 */

type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

type PiAssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type PiAssistantMessageEvent = Extract<
  AgentEvent,
  { readonly type: "message_update" }
>["assistantMessageEvent"];

// The adapter writes Pi's unions out so no vendor type escapes in its
// declarations; these three make drift from the pinned SDK a compile error.
const typesMatch: Equal<PiEventType, AgentEvent["type"]> = true;
const stopReasonsMatch: Equal<PiStopReason, PiAssistantMessage["stopReason"]> = true;
const messageEventTypesMatch: Equal<PiAssistantMessageEventType, PiAssistantMessageEvent["type"]> =
  true;

function translateAll(baseSeq: number, events: readonly unknown[]): readonly RunEvent[] {
  const translator = new PiRunTranslator({
    threadId: "thread-1",
    runId: "run-1",
    startSeq: baseSeq,
  });
  const out: RunEvent[] = [];

  for (const event of events) {
    const result = translator.translate(event);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      out.push(...result.events);
    }
  }

  return out;
}

function eventTypes(events: readonly RunEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

describe("the Pi event mapping table", () => {
  it("classifies exactly Pi's canonical event union", () => {
    expect(typesMatch).toBe(true);
    expect(stopReasonsMatch).toBe(true);
    expect(messageEventTypesMatch).toBe(true);
    expect(Object.keys(PI_EVENT_MAPPING).sort()).toEqual(
      [
        "agent_end",
        "agent_start",
        "message_end",
        "message_start",
        "message_update",
        "tool_execution_end",
        "tool_execution_start",
        "tool_execution_update",
        "turn_end",
        "turn_start",
      ].sort(),
    );
  });

  it("only names RunEvent types that exist", () => {
    for (const [type, mapping] of Object.entries(PI_EVENT_MAPPING)) {
      for (const emitted of mapping.emits) {
        expect(RUN_EVENT_TYPES, `${type} emits ${emitted}`).toContain(emitted);
      }
    }
  });
});

describe("the strict Pi event parser", () => {
  it("refuses an unknown event type", () => {
    const translator = new PiRunTranslator({ threadId: "t", runId: "r", startSeq: 1 });
    const result = translator.translate({ type: "agent_paused" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnknownPiEventType);
    }
  });

  it("refuses an unknown field on a known event", () => {
    const translator = new PiRunTranslator({ threadId: "t", runId: "r", startSeq: 1 });
    const result = translator.translate({ type: "agent_start", futureField: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnknownPiEventField);
    }
  });

  it("refuses an unknown nested assistant message event", () => {
    const translator = new PiRunTranslator({ threadId: "t", runId: "r", startSeq: 1 });
    const result = translator.translate({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_something" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnknownPiMessageEventType);
    }
  });

  it("refuses a text delta with no delta field", () => {
    const translator = new PiRunTranslator({ threadId: "t", runId: "r", startSeq: 1 });
    const result = translator.translate({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MalformedPiEvent);
    }
  });
});

describe("translating a Pi session to RunEvents", () => {
  it("maps a text turn to started, deltas and completed", () => {
    const events = translateAll(1, [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "Hel" },
      },
      {
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "lo" },
      },
      { type: "message_end", message: { role: "assistant" } },
      { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
    ]);

    expect(eventTypes(events)).toEqual([
      "run.started",
      "token.delta",
      "token.delta",
      "run.completed",
    ]);
    expect(events[1]).toMatchObject({ seq: 2, messageId: "assistant-1", delta: "Hel" });
    expect(events.at(-1)).toMatchObject({ type: "run.completed", messageId: "assistant-1" });
    for (const event of events) {
      expect(parseRunEvent(event).ok).toBe(true);
    }
  });

  it("maps a successful tool execution to requested and completed", () => {
    const events = translateAll(1, [
      { type: "agent_start" },
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "echo",
        args: { text: "hi" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "echo",
        result: { content: [{ type: "text", text: "hi" }], details: {} },
        isError: false,
      },
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
    ]);

    expect(eventTypes(events)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "run.completed",
    ]);
    expect(events[2]).toMatchObject({ callId: "call-1", result: { details: {} } });
  });

  it("maps a failed tool execution to tool.failed with the reported content", () => {
    const events = translateAll(1, [
      { type: "agent_start" },
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "explode",
        args: {},
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "explode",
        result: { content: [{ type: "text", text: "it broke" }], details: {} },
        isError: true,
      },
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
    ]);

    expect(eventTypes(events)).toEqual([
      "run.started",
      "tool.requested",
      "tool.failed",
      "run.completed",
    ]);
    expect(events[2]).toMatchObject({ callId: "call-1", error: "it broke" });
  });

  it("maps an error turn to run.failed and an aborted turn to run.cancelled", () => {
    const failed = translateAll(1, [
      { type: "agent_start" },
      {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "the model errored" }],
      },
    ]);
    expect(eventTypes(failed)).toEqual(["run.started", "run.failed"]);
    expect(failed[1]).toMatchObject({ error: "the model errored" });

    const cancelled = translateAll(1, [
      { type: "agent_start" },
      {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "operator stop" }],
      },
    ]);
    expect(eventTypes(cancelled)).toEqual(["run.started", "run.cancelled"]);
    expect(cancelled[1]).toMatchObject({ reason: "operator stop" });
  });

  it("allocates contiguous sequence numbers and separate assistant ids per turn", () => {
    const translator = new PiRunTranslator({ threadId: "t", runId: "r", startSeq: 10 });
    translator.translate({ type: "agent_start" });
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    translator.translate({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "a" },
    });
    translator.translate({ type: "message_end", message: { role: "assistant" } });
    translator.translate({ type: "message_start", message: { role: "assistant" } });
    const second = translator.translate({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "b" },
    });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.events[0]).toMatchObject({ seq: 12, messageId: "assistant-2" });
    }
  });

  it("refuses an event after the terminal event and a second terminal", () => {
    const translator = new PiRunTranslator({ threadId: "t", runId: "r", startSeq: 1 });
    expect(translator.translate({ type: "agent_start" }).ok).toBe(true);
    expect(
      translator.translate({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
      }).ok,
    ).toBe(true);

    const after = translator.translate({ type: "turn_start" });
    expect(after.ok).toBe(false);

    const second = translator.translate({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    expect(second.ok).toBe(false);
  });

  it("refuses a terminal event whose stop reason is not terminal", () => {
    const translator = new PiRunTranslator({ threadId: "t", runId: "r", startSeq: 1 });
    translator.translate({ type: "agent_start" });
    const result = translator.translate({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "deferred" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PiEventSequenceError);
    }
  });
});
