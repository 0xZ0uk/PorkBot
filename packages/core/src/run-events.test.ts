import { describe, expect, it } from "vitest";
import {
  isRunEventType,
  MalformedRunEvent,
  parseRunEvent,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_TYPES,
  RunEventError,
  UnknownEventType,
  UnknownSchemaVersion,
} from "./run-events.ts";
import type { RunEvent, RunEventType } from "./run-events.ts";

const threadId = "thread-1";
const runId = "run-1";

function base(seq: number) {
  return { schemaVersion: RUN_EVENT_SCHEMA_VERSION, seq, threadId, runId } as const;
}

const validEvents: Record<RunEventType, RunEvent> = {
  "run.started": { ...base(9), type: "run.started" },
  "token.delta": { ...base(1), type: "token.delta", messageId: "msg-1", delta: "Hi" },
  "tool.requested": {
    ...base(2),
    type: "tool.requested",
    callId: "call-1",
    tool: "shell",
    arguments: { command: "ls" },
  },
  "approval.requested": {
    ...base(10),
    type: "approval.requested",
    callId: "call-1",
    expiresAt: "2026-09-18T12:00:00.000Z",
  },
  "approval.resolved": {
    ...base(11),
    type: "approval.resolved",
    callId: "call-1",
    decision: "denied",
    reason: "not this one",
  },
  "tool.completed": {
    ...base(3),
    type: "tool.completed",
    callId: "call-1",
    result: { exitCode: 0 },
  },
  "tool.failed": { ...base(4), type: "tool.failed", callId: "call-1", error: "boom" },
  "run.completed": { ...base(5), type: "run.completed", messageId: "msg-1" },
  "run.failed": { ...base(6), type: "run.failed", error: "boom", code: "provider_error" },
  "run.cancelled": { ...base(7), type: "run.cancelled", reason: "operator" },
  "run.steered": { ...base(8), type: "run.steered", messageId: "msg-2", text: "wait" },
};

function parseFailure(event: unknown): MalformedRunEvent {
  const result = parseRunEvent(event);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected the parser to reject the event");
  }

  expect(result.error).toBeInstanceOf(MalformedRunEvent);
  if (!(result.error instanceof MalformedRunEvent)) {
    throw new Error("expected a malformed event error");
  }

  return result.error;
}

describe("parseRunEvent", () => {
  it.each([...RUN_EVENT_TYPES])("accepts a valid %s event", (type) => {
    expect(parseRunEvent(validEvents[type])).toEqual({ ok: true, event: validEvents[type] });
  });

  it("omits absent optional fields instead of inventing them", () => {
    const completed = parseRunEvent({ ...base(1), type: "run.completed" });
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect("messageId" in completed.event).toBe(false);
    }

    const failed = parseRunEvent({ ...base(2), type: "run.failed", error: "boom" });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect("code" in failed.event).toBe(false);
    }

    const cancelled = parseRunEvent({ ...base(3), type: "run.cancelled" });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect("reason" in cancelled.event).toBe(false);
    }
  });

  it("accepts empty free text but rejects empty identifiers", () => {
    expect(
      parseRunEvent({ ...base(1), type: "token.delta", messageId: "msg-1", delta: "" }),
    ).toEqual({
      ok: true,
      event: { ...base(1), type: "token.delta", messageId: "msg-1", delta: "" },
    });
    expect(parseRunEvent({ ...base(2), type: "tool.failed", callId: "call-1", error: "" }).ok).toBe(
      true,
    );
    expect(parseRunEvent({ ...base(3), type: "run.failed", error: "", code: "boom" }).ok).toBe(
      true,
    );
    expect(
      parseRunEvent({ ...base(4), type: "run.steered", messageId: "msg-2", text: "" }).ok,
    ).toBe(true);

    expect(
      parseFailure({ ...base(5), type: "token.delta", messageId: "", delta: "x" }).reason,
    ).toBe("messageId must be a non-empty string");
  });

  it("ignores unknown fields within a known schema version", () => {
    const result = parseRunEvent({ ...base(1), type: "run.completed", futureField: true });
    expect(result.ok).toBe(true);
  });

  const unsupportedVersions: ReadonlyArray<readonly [string, unknown]> = [
    ["zero", 0],
    ["future number", 2],
    ["fraction", 1.5],
    ["string", "1"],
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
    ["bigint", 2n],
    ["object", {}],
    ["symbol", Symbol("version")],
    ["function", () => 1],
  ];

  it.each(unsupportedVersions)(
    "rejects a %s schemaVersion with a typed error",
    (_label, version) => {
      const result = parseRunEvent({ ...base(1), schemaVersion: version, type: "run.completed" });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error).toBeInstanceOf(UnknownSchemaVersion);
      expect(result.error).toBeInstanceOf(RunEventError);
      if (result.error instanceof UnknownSchemaVersion) {
        expect(result.error.received).toBe(version);
        expect(result.error.supported).toBe(RUN_EVENT_SCHEMA_VERSION);
        expect(result.error.name).toBe("UnknownSchemaVersion");
      }
    },
  );

  it("rejects a missing schemaVersion with the same typed error", () => {
    const result = parseRunEvent({ seq: 1, threadId, runId, type: "run.completed" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnknownSchemaVersion);
    }
  });

  const unsupportedTypes: ReadonlyArray<readonly [string, unknown]> = [
    ["missing", undefined],
    ["unimplemented", "run.approved"],
    ["similar", "token"],
    ["casing", "TOKEN.DELTA"],
    ["number", 42],
    ["null", null],
    ["object", {}],
  ];

  it.each(unsupportedTypes)("rejects an unknown %s type with a typed error", (_label, type) => {
    const result = parseRunEvent({ ...base(1), type });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toBeInstanceOf(UnknownEventType);
    if (result.error instanceof UnknownEventType) {
      expect(result.error.received).toBe(type);
      expect(result.error.name).toBe("UnknownEventType");
    }
  });

  const nonObjects: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["string", "run.completed"],
    ["number", 7],
    ["boolean", true],
    ["array", []],
    ["nested array", [{ type: "run.completed" }]],
    ["function", () => 1],
  ];

  it.each(nonObjects)("rejects a %s event as malformed", (_label, value) => {
    const error = parseFailure(value);
    expect(error.reason).toBe("event must be an object");
    expect(error.received).toBe(value);
  });

  const invalidSequences: ReadonlyArray<readonly [string, unknown]> = [
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["string", "1"],
    ["null", null],
    ["undefined", undefined],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ];

  it.each(invalidSequences)("rejects a %s seq as malformed", (_label, seq) => {
    const error = parseFailure({ ...base(1), seq, type: "run.completed" });
    expect(error.reason).toBe("seq must be a positive integer");
    expect(error.received).toBe(seq);
  });

  it("accepts the largest safe seq", () => {
    const result = parseRunEvent({ ...base(Number.MAX_SAFE_INTEGER), type: "run.completed" });
    expect(result.ok).toBe(true);
  });

  it("rejects empty or non-string thread and run identities", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["threadId", ""],
      ["threadId", 7],
      ["threadId", null],
      ["runId", ""],
      ["runId", {}],
    ];

    for (const [field, value] of cases) {
      const error = parseFailure({ ...base(1), type: "run.completed", [field]: value });
      expect(error.reason).toBe(`${field} must be a non-empty string`);
      expect(error.received).toBe(value);
    }
  });

  it("rejects malformed token events", () => {
    expect(parseFailure({ ...base(1), type: "token.delta", delta: "x" }).reason).toBe(
      "messageId must be a non-empty string",
    );
    expect(parseFailure({ ...base(1), type: "token.delta", messageId: "m", delta: 7 }).reason).toBe(
      "delta must be a string",
    );
  });

  it("rejects malformed tool events", () => {
    expect(
      parseFailure({ ...base(1), type: "tool.requested", callId: "c", arguments: null }).reason,
    ).toBe("tool must be a non-empty string");
    expect(
      parseFailure({ ...base(1), type: "tool.requested", callId: "c", tool: "t" }).reason,
    ).toBe("arguments must be present");
    expect(parseFailure({ ...base(1), type: "tool.completed", callId: "c" }).reason).toBe(
      "result must be present",
    );
    expect(parseFailure({ ...base(1), type: "tool.failed", callId: "c", error: 1 }).reason).toBe(
      "error must be a string",
    );
    expect(parseFailure({ ...base(1), type: "tool.failed", error: "x" }).reason).toBe(
      "callId must be a non-empty string",
    );
  });

  it("accepts present-but-null arguments and results", () => {
    expect(
      parseRunEvent({
        ...base(1),
        type: "tool.requested",
        callId: "c",
        tool: "t",
        arguments: null,
      }).ok,
    ).toBe(true);
    expect(
      parseRunEvent({ ...base(2), type: "tool.completed", callId: "c", result: null }).ok,
    ).toBe(true);
  });

  it("rejects malformed approval events", () => {
    expect(parseFailure({ ...base(1), type: "approval.requested", expiresAt: "x" }).reason).toBe(
      "callId must be a non-empty string",
    );
    expect(parseFailure({ ...base(1), type: "approval.requested", callId: "c" }).reason).toBe(
      "expiresAt must be an ISO 8601 UTC timestamp",
    );
    expect(
      parseFailure({ ...base(1), type: "approval.requested", callId: "c", expiresAt: "soon" })
        .reason,
    ).toBe("expiresAt must be an ISO 8601 UTC timestamp");

    // The contract's `z.iso.datetime()` is stricter than `Date.parse`: a date
    // without a time, a non-UTC offset or an impossible day is refused here too.
    for (const expiresAt of [
      "2026-09-18",
      "2026-09-18T12:00:00",
      "2026-09-18T12:00:00+02:00",
      "2026-09-18T12:00:00.000+02:00",
      "2026-13-40T00:00:00Z",
    ]) {
      expect(
        parseFailure({ ...base(1), type: "approval.requested", callId: "c", expiresAt }).reason,
      ).toBe("expiresAt must be an ISO 8601 UTC timestamp");
    }

    expect(
      parseFailure({
        ...base(1),
        type: "approval.resolved",
        callId: "c",
        decision: "maybe",
      }).reason,
    ).toBe("decision must be one of approved, denied, timed_out");
    expect(parseFailure({ ...base(1), type: "approval.resolved", callId: "c" }).reason).toBe(
      "decision must be one of approved, denied, timed_out",
    );
    expect(
      parseFailure({
        ...base(1),
        type: "approval.resolved",
        callId: "c",
        decision: "approved",
        reason: "",
      }).reason,
    ).toBe("reason must be a non-empty string");
  });

  it("omits an absent resolved reason instead of inventing one", () => {
    const resolved = parseRunEvent({
      ...base(1),
      type: "approval.resolved",
      callId: "c",
      decision: "timed_out",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect("reason" in resolved.event).toBe(false);
    }
  });

  it("carries a tool call's timing and its oversized-result pointer", () => {
    expect(
      parseRunEvent({
        ...base(1),
        type: "tool.completed",
        callId: "c",
        result: '{"text":"…"} [truncated]',
        resultArtifact: { kind: "tool_call", callId: "c", bytes: 9_999 },
        durationMs: 1_250,
      }),
    ).toEqual({
      ok: true,
      event: {
        ...base(1),
        type: "tool.completed",
        callId: "c",
        result: '{"text":"…"} [truncated]',
        resultArtifact: { kind: "tool_call", callId: "c", bytes: 9_999 },
        durationMs: 1_250,
      },
    });

    expect(
      parseRunEvent({ ...base(2), type: "tool.failed", callId: "c", error: "boom", durationMs: 7 }),
    ).toEqual({
      ok: true,
      event: { ...base(2), type: "tool.failed", callId: "c", error: "boom", durationMs: 7 },
    });
  });

  it("omits absent timing and artifact fields instead of inventing them", () => {
    const result = parseRunEvent({ ...base(1), type: "tool.completed", callId: "c", result: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("resultArtifact" in result.event).toBe(false);
      expect("durationMs" in result.event).toBe(false);
    }
  });

  it("rejects malformed tool timing and result-pointer fields", () => {
    const completed = { ...base(1), type: "tool.completed", callId: "c", result: null } as const;

    for (const durationMs of [-1, 1.5, "10", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseFailure({ ...completed, durationMs }).reason).toBe(
        "durationMs must be a non-negative integer",
      );
    }

    expect(parseFailure({ ...completed, resultArtifact: 5 }).reason).toBe(
      "resultArtifact must be an object",
    );
    expect(
      parseFailure({ ...completed, resultArtifact: { kind: "blob", callId: "c", bytes: 1 } })
        .reason,
    ).toBe('resultArtifact.kind must be "tool_call"');
    expect(
      parseFailure({ ...completed, resultArtifact: { kind: "tool_call", callId: "", bytes: 1 } })
        .reason,
    ).toBe("callId must be a non-empty string");
    expect(
      parseFailure({ ...completed, resultArtifact: { kind: "tool_call", callId: "c", bytes: -1 } })
        .reason,
    ).toBe("bytes must be a non-negative integer");
  });

  it("rejects malformed terminal events", () => {
    expect(parseFailure({ ...base(1), type: "run.completed", messageId: "" }).reason).toBe(
      "messageId must be a non-empty string",
    );
    expect(parseFailure({ ...base(1), type: "run.failed", error: "x", code: 1 }).reason).toBe(
      "code must be a non-empty string",
    );
    expect(parseFailure({ ...base(1), type: "run.cancelled", reason: "" }).reason).toBe(
      "reason must be a non-empty string",
    );
    expect(parseFailure({ ...base(1), type: "run.steered", messageId: "m" }).reason).toBe(
      "text must be a string",
    );
  });
});

describe("isRunEventType", () => {
  it("recognizes every declared type and nothing else", () => {
    for (const type of RUN_EVENT_TYPES) {
      expect(isRunEventType(type)).toBe(true);
    }

    for (const value of [undefined, null, 0, "", "TOKEN.DELTA", "run.paused"]) {
      expect(isRunEventType(value)).toBe(false);
    }
  });
});

describe("run event errors", () => {
  it("share a base class and carry the malformed detail", () => {
    const error = new MalformedRunEvent("seq must be a positive integer", 0);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RunEventError);
    expect(error.name).toBe("MalformedRunEvent");
    expect(error.message).toBe("Malformed run event: seq must be a positive integer");
    expect(error.reason).toBe("seq must be a positive integer");
    expect(error.received).toBe(0);
  });

  it("name the supported version and the unknown type", () => {
    expect(new UnknownSchemaVersion(2).message).toBe(
      "Unsupported run event schemaVersion: 2 (supported: 1)",
    );
    expect(new UnknownEventType("run.approved").message).toBe(
      'Unknown run event type: "run.approved"',
    );
  });
});
