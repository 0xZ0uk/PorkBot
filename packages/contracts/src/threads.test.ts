import type { AnyContractProcedure } from "@orpc/contract";
import { MAX_MESSAGE_TEXT_LENGTH, RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  defaultMessagePageSize,
  defaultThreadPageSize,
  messageSchema,
  runEventSchema,
  threadsClearContract,
  threadsCreateContract,
  threadsEventsContract,
  threadsListContract,
  threadsMessagesContract,
  threadsSendContract,
} from "./threads.ts";
import type { RunEventMessage } from "./threads.ts";

/**
 * The wire schema and the domain union are two declarations of one vocabulary,
 * so this suite pins them together: every shape core's parser produces must
 * validate on the wire, an unknown type must not, and the compiler proves the
 * inferred wire event is the `RunEvent` the shared reducer consumes. A drift in
 * either direction is a contract bug, not a runtime surprise.
 */

const base = {
  schemaVersion: RUN_EVENT_SCHEMA_VERSION,
  threadId: "thread-1",
  runId: "run-1",
} as const;

const samples: readonly RunEvent[] = [
  { ...base, seq: 1, type: "run.started" },
  { ...base, seq: 2, type: "token.delta", messageId: "message-1", delta: "" },
  { ...base, seq: 3, type: "tool.requested", callId: "call-1", tool: "shell", arguments: {} },
  {
    ...base,
    seq: 4,
    type: "approval.requested",
    callId: "call-1",
    expiresAt: "2026-09-18T12:00:00.000Z",
  },
  { ...base, seq: 5, type: "approval.resolved", callId: "call-1", decision: "approved" },
  {
    ...base,
    seq: 6,
    type: "approval.resolved",
    callId: "call-1",
    decision: "denied",
    reason: "not this one",
  },
  { ...base, seq: 7, type: "approval.resolved", callId: "call-1", decision: "timed_out" },
  { ...base, seq: 8, type: "tool.completed", callId: "call-1", result: null },
  {
    ...base,
    seq: 9,
    type: "tool.completed",
    callId: "call-1",
    result: "preview [truncated]",
    resultArtifact: { kind: "tool_call", callId: "call-1", bytes: 9_999 },
    durationMs: 1_250,
  },
  { ...base, seq: 10, type: "tool.failed", callId: "call-1", error: "" },
  { ...base, seq: 11, type: "tool.failed", callId: "call-1", error: "boom", durationMs: 40 },
  { ...base, seq: 12, type: "run.completed" },
  { ...base, seq: 13, type: "run.completed", messageId: "message-1" },
  { ...base, seq: 14, type: "run.failed", error: "" },
  { ...base, seq: 15, type: "run.failed", error: "boom", code: "MODEL_FAILED" },
  { ...base, seq: 16, type: "run.cancelled" },
  { ...base, seq: 17, type: "run.cancelled", reason: "operator stopped it" },
  { ...base, seq: 18, type: "run.steered", messageId: "message-1", text: "" },
];

describe("the thread event wire schema", () => {
  it("accepts every shape core's parser produces, with optional fields present and absent", () => {
    for (const event of samples) {
      expect(runEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
  });

  it("refuses an unknown type, a wrong schema version and a missing field", () => {
    expect(
      runEventSchema.safeParse({ ...base, seq: 1, type: "message.created" }).success,
      "an unknown event type must not reach a client as if it were understood",
    ).toBe(false);
    expect(
      runEventSchema.safeParse({ ...base, schemaVersion: 2, seq: 1, type: "run.started" }).success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse({ ...base, seq: 1, type: "token.delta", messageId: "message-1" })
        .success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse({
        ...base,
        seq: 1,
        type: "approval.resolved",
        callId: "call-1",
        decision: "maybe",
      }).success,
    ).toBe(false);
  });

  it("types its output as core's RunEvent union in both directions", () => {
    expectTypeOf<RunEventMessage>().toExtend<RunEvent>();
    expectTypeOf<RunEvent>().toExtend<RunEventMessage>();
  });
});

describe("the subscription contract", () => {
  it("names the thread and routes the resume through the SSE id", () => {
    const definition = threadsEventsContract["~orpc"];

    expect(definition.route).toMatchObject({
      method: "GET",
      path: "/threads/{threadId}/events",
    });
    expect(definition.meta).toMatchObject({ access: "authenticated" });
    expect(definition.errorMap).toHaveProperty("NOT_FOUND");
    expect(definition.errorMap).toHaveProperty("BAD_REQUEST");
  });
});

/**
 * The input schema a procedure declared, which every contract here does. oRPC
 * types it as its schema-agnostic `AnySchema`; this package declares every
 * schema with zod (a pinned dependency), so the narrowing is a fact about how
 * the contract is written rather than a hope about the runtime.
 */
function inputSchemaOf(procedure: AnyContractProcedure): z.ZodType {
  const schema = procedure["~orpc"].inputSchema;

  if (schema === undefined) {
    throw new Error("the contract procedure declares no input schema");
  }

  return schema as unknown as z.ZodType;
}

describe("the thread surface contracts", () => {
  it("routes every procedure through the authenticated gate", () => {
    const routes = [
      [threadsCreateContract, "POST", "/threads"],
      [threadsListContract, "GET", "/bots/{botId}/threads"],
      [threadsMessagesContract, "GET", "/threads/{threadId}/messages"],
      [threadsSendContract, "POST", "/threads/{threadId}/messages"],
      [threadsClearContract, "POST", "/threads/{threadId}/clear"],
    ] as const;

    for (const [contract, method, path] of routes) {
      const definition = contract["~orpc"];

      expect(definition.route).toMatchObject({ method, path });
      expect(definition.meta).toMatchObject({ access: "authenticated" });
      expect(definition.errorMap).toHaveProperty("NOT_FOUND");
    }
  });

  it("declares the send's refusal vocabulary as typed errors", () => {
    const definition = threadsSendContract["~orpc"];

    expect(definition.errorMap).toHaveProperty("BAD_REQUEST");
    expect(definition.errorMap).toHaveProperty("CONFLICT");
  });

  it("bounds the text and the nonce at the schema, before the policy runs", () => {
    const schema = inputSchemaOf(threadsSendContract);

    expect(
      schema.safeParse({
        threadId: "thread-1",
        text: "hi",
        clientNonce: "nonce-1",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        threadId: "thread-1",
        text: "",
        clientNonce: "nonce-1",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        threadId: "thread-1",
        text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1),
        clientNonce: "nonce-1",
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ threadId: "thread-1", text: "hi", clientNonce: "" }).success).toBe(
      false,
    );
  });

  it("defaults the page sizes and accepts the typed keyset cursor", () => {
    const listSchema = inputSchemaOf(threadsListContract);
    const parsedList = listSchema.parse({ botId: "bot-1" });

    expect(parsedList).toEqual({ botId: "bot-1", limit: defaultThreadPageSize });
    expect(
      listSchema.safeParse({
        botId: "bot-1",
        limit: 10,
        after: {
          updatedAt: "2026-09-18T12:00:00.000Z",
          id: "00000000-0000-7000-8000-000000000000",
        },
      }).success,
    ).toBe(true);
    expect(
      listSchema.safeParse({ botId: "bot-1", after: { updatedAt: "not-a-date", id: "thread-1" } })
        .success,
    ).toBe(false);
    expect(
      listSchema.safeParse({
        botId: "bot-1",
        after: { updatedAt: "2026-09-18T12:00:00.000Z", id: "not-a-uuid" },
      }).success,
    ).toBe(false);

    expect(inputSchemaOf(threadsMessagesContract).parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
      limit: defaultMessagePageSize,
    });
  });

  it("refuses a message block kind this build does not read", () => {
    const message = {
      id: "message-1",
      threadId: "thread-1",
      seq: 0,
      role: "user",
      blocks: [{ type: "text", text: "hello" }],
      runId: null,
      createdAt: "2026-09-18T12:00:00.000Z",
    };

    expect(messageSchema.safeParse(message).success).toBe(true);
    expect(
      messageSchema.safeParse({
        ...message,
        blocks: [{ type: "image", url: "https://example.test/a.png" }],
      }).success,
    ).toBe(false);
    expect(messageSchema.safeParse({ ...message, role: "system" }).success).toBe(false);
  });
});
