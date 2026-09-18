import type { ToolResultArtifact } from "./run-events.ts";

/**
 * The size policy for a tool result persisted as a run event (slice 5.6).
 *
 * A tool can legitimately return more than an event row or an SSE frame should
 * carry, and the audit must not depend on what fits: a result larger than
 * `maxInlineBytes` is replaced with a bounded preview plus a `resultArtifact`
 * pointer to the tool call's durable effect row, which holds the whole value.
 * Truncation is therefore explicit — a reader can always tell that it is seeing
 * a preview and where the rest lives — rather than a silent drop.
 *
 * The policy is pure so the same limits decide the live stream and the durable
 * record: the recorder in `@porkbot/effect` runs it before an event reaches
 * either, so a live client and a reloading one see the same shape (slice 5.6's
 * timeline criterion).
 */

export interface ToolResultLimits {
  /** Largest serialized result kept inline, in UTF-8 bytes. */
  readonly maxInlineBytes: number;
  /** Bytes of the serialized result kept as the preview when it is too large. */
  readonly previewBytes: number;
}

/** 64 KiB inline and a 2 KiB preview: large enough for ordinary tool output. */
export const DEFAULT_TOOL_RESULT_LIMITS: ToolResultLimits = {
  maxInlineBytes: 65_536,
  previewBytes: 2_048,
};

/** Appended to a preview so a plain string preview is never mistaken for the value. */
export const toolResultTruncationMarker = "[truncated]";

/** The preview a result with no JSON form is replaced by; the artifact says so. */
export const unserializableToolResultPreview = "[unserializable tool result]";

export interface ToolResultSummary {
  /** The value when it fits, otherwise a bounded JSON preview of it. */
  readonly result: unknown;
  /** Present exactly when `result` is a preview; points at the full value. */
  readonly artifact?: ToolResultArtifact;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Summarizes one result for the event stream. The `callId` names the artifact
 * the summary points at, so the caller must be summarising a completed call.
 */
export function summarizeToolResult(
  result: unknown,
  callId: string,
  limits: ToolResultLimits = DEFAULT_TOOL_RESULT_LIMITS,
): ToolResultSummary {
  if (callId.trim() === "") {
    throw new RangeError("a tool result summary needs the call id of the call it summarizes");
  }

  assertLimit("maxInlineBytes", limits.maxInlineBytes);
  assertLimit("previewBytes", limits.previewBytes);

  const json = serialize(result);

  // No JSON form means no event row and no preview of the value itself; the
  // marker and the pointer keep the fact visible rather than dropping it.
  if (json === undefined) {
    return {
      result: unserializableToolResultPreview,
      artifact: { kind: "tool_call", callId, bytes: 0 },
    };
  }

  const bytes = encoder.encode(json).length;

  if (bytes <= limits.maxInlineBytes) {
    return { result };
  }

  return {
    result: `${preview(json, limits.previewBytes)} ${toolResultTruncationMarker}`,
    artifact: { kind: "tool_call", callId, bytes },
  };
}

function assertLimit(field: keyof ToolResultLimits, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer, received ${String(value)}`);
  }
}

function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value ?? null) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The UTF-8 prefix of the serialized result. A prefix that ends mid-character
 * decodes to a replacement character, so a trailing one is dropped rather than
 * delivered as content.
 */
function preview(json: string, previewBytes: number): string {
  const bytes = encoder.encode(json);
  return decoder.decode(bytes.subarray(0, previewBytes)).replace(/\uFFFD$/, "");
}
