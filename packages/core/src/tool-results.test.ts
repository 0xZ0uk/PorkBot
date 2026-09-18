import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_RESULT_LIMITS,
  summarizeToolResult,
  toolResultTruncationMarker,
  unserializableToolResultPreview,
} from "./tool-results.ts";

/**
 * The size policy that keeps a tool result inside an event row without losing
 * it: within the budget the value is untouched, above it the summary is a
 * bounded preview plus a pointer to the artifact, and a value with no JSON form
 * is named rather than dropped. The same function runs on the live stream and
 * the durable record, so these decisions are the ones a reloading client sees.
 */

const tight = { maxInlineBytes: 64, previewBytes: 16 };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe("summarizeToolResult", () => {
  it("keeps a result that fits the inline budget exactly as it was", () => {
    const result = { exitCode: 0, stdout: "ok" };
    expect(summarizeToolResult(result, "call-1")).toEqual({ result });
  });

  it("keeps a result exactly at the budget inline", () => {
    const result = { text: "x".repeat(40) };
    const bytes = byteLength(JSON.stringify(result));

    expect(summarizeToolResult(result, "call-1", { ...tight, maxInlineBytes: bytes })).toEqual({
      result,
    });
  });

  it("replaces an oversized result with a bounded preview and an artifact pointer", () => {
    const result = { text: "x".repeat(4_096) };
    const summary = summarizeToolResult(result, "call-1", tight);

    expect(summary.artifact).toEqual({
      kind: "tool_call",
      callId: "call-1",
      bytes: byteLength(JSON.stringify(result)),
    });

    const preview = String(summary.result);
    expect(preview.endsWith(toolResultTruncationMarker)).toBe(true);

    const content = preview.slice(0, -toolResultTruncationMarker.length - 1);
    expect(byteLength(content)).toBeLessThanOrEqual(tight.previewBytes);
    expect(content).toBe(JSON.stringify(result).slice(0, content.length));
    expect(summary.artifact?.bytes).toBeGreaterThan(tight.maxInlineBytes);
  });

  it("measures the size in UTF-8 bytes, not code units", () => {
    const result = { text: "é".repeat(30) };
    const bytes = byteLength(JSON.stringify(result));
    expect(bytes).toBeGreaterThan(tight.maxInlineBytes);

    const summary = summarizeToolResult(result, "call-1", tight);
    expect(summary.artifact?.bytes).toBe(bytes);
    expect(summary.artifact?.callId).toBe("call-1");
  });

  it("does not split a multi-byte character at the preview boundary", () => {
    const summary = summarizeToolResult({ text: "é".repeat(1_000) }, "call-1", {
      maxInlineBytes: 32,
      previewBytes: 14,
    });

    expect(String(summary.result)).not.toContain("\uFFFD");
  });

  it("names a value with no JSON form instead of dropping it silently", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    for (const result of [circular, 10n, () => "nope"]) {
      expect(summarizeToolResult(result, "call-1", tight)).toEqual({
        result: unserializableToolResultPreview,
        artifact: { kind: "tool_call", callId: "call-1", bytes: 0 },
      });
    }
  });

  it("treats an absent result as null, the value that was actually returned", () => {
    const summary = summarizeToolResult(undefined, "call-1");
    expect("result" in summary).toBe(true);
    expect(summary.result).toBeUndefined();
    expect(summary.artifact).toBeUndefined();

    expect(
      summarizeToolResult(undefined, "call-1", { maxInlineBytes: 1, previewBytes: 1 }),
    ).toEqual({
      result: "n [truncated]",
      artifact: { kind: "tool_call", callId: "call-1", bytes: 4 },
    });
  });

  it("refuses a blank call id and a non-positive limit", () => {
    expect(() => summarizeToolResult("x", " ")).toThrow(RangeError);
    expect(() =>
      summarizeToolResult("x", "call-1", { maxInlineBytes: 0, previewBytes: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      summarizeToolResult("x", "call-1", { maxInlineBytes: 10, previewBytes: 1.5 }),
    ).toThrow(RangeError);
  });

  it("ships a default budget big enough for ordinary tool output", () => {
    expect(summarizeToolResult({ stdout: "x".repeat(1_000) }, "call-1").artifact).toBeUndefined();
    expect(DEFAULT_TOOL_RESULT_LIMITS.maxInlineBytes).toBeGreaterThan(
      DEFAULT_TOOL_RESULT_LIMITS.previewBytes,
    );
  });
});
