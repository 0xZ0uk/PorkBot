import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type {
  RunEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolRequestedEvent,
} from "@porkbot/core";
import { describe, expect, it } from "vitest";
import { createRunEventRecorder } from "./run-events.ts";

/**
 * The recorder is the single transform between a session's wire events and
 * every consumer: the durable row, the live SSE frame and a replayed one. These
 * tests pin its three decisions — redact secret-shaped arguments, point an
 * oversized result at its artifact, stamp a settled call's duration — and that
 * a resolution the recorder did not see stays honestly untimed.
 */

const threadId = "thread-1";
const runId = "run-1";

const base = { schemaVersion: RUN_EVENT_SCHEMA_VERSION, threadId, runId } as const;

function requested(
  seq: number,
  callId: string,
  tool: string,
  callArguments: unknown,
): ToolRequestedEvent {
  return { ...base, seq, type: "tool.requested", callId, tool, arguments: callArguments };
}

function completed(seq: number, callId: string, result: unknown): ToolCompletedEvent {
  return { ...base, seq, type: "tool.completed", callId, result };
}

function failed(seq: number, callId: string, error: string): ToolFailedEvent {
  return { ...base, seq, type: "tool.failed", callId, error };
}

const tight = { maxInlineBytes: 64, previewBytes: 16 };

function recorderAt(startMs = 0) {
  let now = startMs;
  const recorder = createRunEventRecorder({ clock: () => now, limits: tight });

  return {
    recorder,
    advance(toMs: number) {
      now = toMs;
    },
  };
}

describe("RunEventRecorder redaction", () => {
  it("redacts secret-shaped arguments by field name and by string shape", () => {
    const { recorder } = recorderAt();
    const event = requested(1, "call-1", "shell", {
      command: "echo hi",
      apiKey: "sk-live-0123456789abcdef",
      note: "sent with Bearer abc.def.ghi",
      nested: { password: "hunter2", token: "opaque" },
    });

    const recorded = recorder.record(event);

    expect(recorded).toEqual({
      ...event,
      arguments: {
        command: "echo hi",
        apiKey: "[redacted]",
        note: "sent with Bearer [redacted]",
        nested: { password: "[redacted]", token: "[redacted]" },
      },
    });

    // The event the runtime handed in is not rewritten in place.
    expect(event.arguments).toEqual({
      command: "echo hi",
      apiKey: "sk-live-0123456789abcdef",
      note: "sent with Bearer abc.def.ghi",
      nested: { password: "hunter2", token: "opaque" },
    });
  });

  it("scrubs secret shapes from a failure message", () => {
    const { recorder } = recorderAt();
    const recorded = recorder.record(failed(1, "call-1", "tool failed: sk-live-0123456789abcdef"));

    expect(recorded).toMatchObject({ error: "tool failed: [redacted]" });
  });
});

describe("RunEventRecorder timing", () => {
  it("stamps a settled call with the wall-clock time it took", () => {
    const { recorder, advance } = recorderAt(1_000);

    recorder.record(requested(1, "call-1", "shell", {}));
    advance(1_750);
    const recorded = recorder.record(completed(2, "call-1", { ok: true }));

    expect(recorded).toMatchObject({ durationMs: 750 });
  });

  it("stamps a failed call the same way", () => {
    const { recorder, advance } = recorderAt(2_000);

    recorder.record(requested(1, "call-2", "shell", {}));
    advance(2_100);
    expect(recorder.record(failed(2, "call-2", "boom"))).toMatchObject({ durationMs: 100 });
  });

  it("keeps the first duration when a resolution is recorded twice", () => {
    const { recorder, advance } = recorderAt(100);

    recorder.record(requested(1, "call-1", "shell", {}));
    advance(600);
    const first = recorder.record(completed(2, "call-1", null));
    advance(9_999);

    expect(first).toMatchObject({ durationMs: 500 });
    expect(recorder.record(completed(2, "call-1", null))).toMatchObject({ durationMs: 500 });
  });

  it("keeps the original start when a request frame is recorded twice", () => {
    const { recorder, advance } = recorderAt(100);

    recorder.record(requested(1, "call-1", "shell", {}));
    advance(900);
    recorder.record(requested(1, "call-1", "shell", {}));
    advance(1_500);

    expect(recorder.record(completed(2, "call-1", null))).toMatchObject({ durationMs: 1_400 });
  });

  it("leaves a resolution it never saw requested untimed", () => {
    const { recorder } = recorderAt();
    const timed = recorder.record(completed(1, "call-1", null));
    const untimed = recorder.record(failed(2, "call-2", "boom"));

    expect("durationMs" in timed).toBe(false);
    expect("durationMs" in untimed).toBe(false);
  });

  it("forgets the run's calls when the run terminates", () => {
    const { recorder, advance } = recorderAt(0);

    recorder.record(requested(1, "call-1", "shell", {}));
    recorder.record({ ...base, seq: 2, type: "run.completed" });
    advance(5_000);

    expect("durationMs" in recorder.record(completed(3, "call-1", null))).toBe(false);
  });
});

describe("RunEventRecorder result size", () => {
  it("replaces an oversized result with a preview and a pointer to its artifact", () => {
    const { recorder } = recorderAt();
    const result = { stdout: "x".repeat(4_096) };
    const bytes = new TextEncoder().encode(JSON.stringify(result)).length;

    recorder.record(requested(1, "call-1", "shell", {}));
    const recorded = recorder.record(completed(2, "call-1", result));

    expect(recorded).toMatchObject({
      resultArtifact: { kind: "tool_call", callId: "call-1", bytes },
    });
    expect(String((recorded as ToolCompletedEvent).result).endsWith("[truncated]")).toBe(true);
  });

  it("leaves a result that fits untouched and adds no pointer", () => {
    const { recorder } = recorderAt();
    const recorded = recorder.record(completed(1, "call-1", { ok: true }));

    expect(recorded).toMatchObject({ result: { ok: true } });
    expect("resultArtifact" in recorded).toBe(false);
  });
});

describe("RunEventRecorder passthrough", () => {
  it("returns every other event exactly as it arrived", () => {
    const { recorder } = recorderAt();
    const events: readonly RunEvent[] = [
      { ...base, seq: 1, type: "run.started" },
      { ...base, seq: 2, type: "token.delta", messageId: "message-1", delta: "hi" },
      { ...base, seq: 3, type: "run.steered", messageId: "message-2", text: "wait" },
    ];

    for (const event of events) {
      expect(recorder.record(event)).toBe(event);
    }
  });
});
