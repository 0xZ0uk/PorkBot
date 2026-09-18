import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { runEventSchema, threadsEventsContract } from "./threads.ts";
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
  { ...base, seq: 4, type: "tool.completed", callId: "call-1", result: null },
  { ...base, seq: 5, type: "tool.failed", callId: "call-1", error: "" },
  { ...base, seq: 6, type: "run.completed" },
  { ...base, seq: 7, type: "run.completed", messageId: "message-1" },
  { ...base, seq: 8, type: "run.failed", error: "" },
  { ...base, seq: 9, type: "run.failed", error: "boom", code: "MODEL_FAILED" },
  { ...base, seq: 10, type: "run.cancelled" },
  { ...base, seq: 11, type: "run.cancelled", reason: "operator stopped it" },
  { ...base, seq: 12, type: "run.steered", messageId: "message-1", text: "" },
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
