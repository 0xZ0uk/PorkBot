import { fileDownloadPath } from "@porkbot/contracts";
import type { RunSnapshot, ToolCallSnapshot } from "@porkbot/core";

/**
 * The run's outcome as the report card reads it (slice 13.8; design record,
 * Conversation grammar): a ✓ line for each call that finished and a → line for
 * what was handed off or still wants the operator, derived from the run's own
 * reduced events.
 *
 * Nothing here is recorded a second time. The card is a second reading of the
 * tool calls the timeline already renders — the same snapshot, the same
 * statuses — so a live run and a reload produce the same card, and a new field
 * on the wire would be the only way for the two to disagree. The one-line
 * target is shared with the collapsed timeline entry, so the card and the
 * entry name the same thing.
 */

/** One line of the card: a ✓ done line or a → follow-up line. */
export interface RunOutcomeLine {
  readonly kind: "done" | "follow_up";
  readonly text: string;
}

/**
 * The argument fields that name a call's target, in the order a reader would
 * look for one. A tool argument is arbitrary JSON, so this is a preference
 * list rather than a schema: the first field a call carries is its target, and
 * a call that carries none falls back to its compact arguments.
 */
const targetFields = [
  "command",
  "path",
  "url",
  "query",
  "selector",
  "name",
  "title",
  "filename",
  "text",
] as const;

/** The longest target a collapsed line or a card line carries before it is cut. */
export const maxTargetLength = 96;

/**
 * One call's one-line target: the argument that names what the call acted on,
 * or its compact arguments when no single field does. Whitespace is collapsed
 * because a shell command or a file body can carry newlines, and a target that
 * wraps is not a one-line target.
 */
export function toolTarget(call: ToolCallSnapshot): string | null {
  const args = call.arguments;

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return typeof args === "string" && args.trim() !== "" ? truncate(oneLine(args)) : null;
  }

  const record = args as Record<string, unknown>;

  for (const field of targetFields) {
    const value = record[field];

    if (typeof value === "string" && value.trim() !== "") {
      return truncate(oneLine(value));
    }
  }

  const entries = Object.entries(record);
  // A record of empty strings has nothing to name either; the compact
  // arguments are a fallback for real values, not a rendering of blanks.
  const named = entries.some(([, value]) => typeof value !== "string" || value.trim() !== "");

  if (!named) {
    return null;
  }

  return truncate(oneLine(JSON.stringify(record)));
}

/**
 * The card's lines, oldest call first. A completed call is done; a failure,
 * a denied gate and a produced file are follow-ups, because each is something
 * the operator reads rather than something the run finished. A terminal
 * failure carries its one line even when no tool ran, so a run that died
 * before its first call still closes with a card.
 */
export function runOutcome(run: RunSnapshot): readonly RunOutcomeLine[] {
  const lines: RunOutcomeLine[] = [];

  for (const call of run.toolCalls) {
    if (call.status === "completed") {
      const target = toolTarget(call);
      lines.push({ kind: "done", text: target === null ? call.tool : `${call.tool} — ${target}` });

      const file = recordedArtifact(call.result);

      if (file !== undefined) {
        lines.push({ kind: "follow_up", text: `Handed off ${file.filename}` });
      }

      continue;
    }

    if (call.status === "failed") {
      lines.push({
        kind: "follow_up",
        text: truncate(oneLine(call.error ?? `tool "${call.tool}" failed`)),
      });

      continue;
    }

    if (call.approval?.status === "denied") {
      lines.push({ kind: "follow_up", text: `${call.tool} — denied by you` });
    } else if (call.approval?.status === "timed_out") {
      lines.push({ kind: "follow_up", text: `${call.tool} — approval expired` });
    }
  }

  if (run.status === "failed" && run.failure !== undefined) {
    lines.push({ kind: "follow_up", text: truncate(oneLine(run.failure.message)) });
  }

  return lines;
}

/**
 * The stored file a result carries, when it is a shape this build reads. The
 * result is untrusted tool output, so the row rebuilds the link from the
 * artifact's id through the contract's path builder instead of trusting a path
 * it carries — a `//host` value would otherwise render as a trusted external
 * link — and a shape this build does not recognise renders nothing rather than
 * a broken link.
 */
export function recordedArtifact(
  result: unknown,
):
  | { readonly filename: string; readonly sizeBytes: number; readonly downloadPath: string }
  | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }

  const value = (result as Record<string, unknown>)["artifact"];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = record["id"];
  const filename = record["filename"];
  const sizeBytes = record["sizeBytes"];

  if (typeof id !== "string" || !isStoredFileId(id)) {
    return undefined;
  }

  if (typeof filename !== "string" || filename === "") {
    return undefined;
  }

  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return undefined;
  }

  return { filename, sizeBytes, downloadPath: fileDownloadPath(id) };
}

/** A stored-file id: the UUID the row's route resolves. */
function isStoredFileId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Durations in seconds under a minute, minutes under ten, then whole minutes. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return minutes >= 10 || rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** Any run of whitespace reads as one space in a one-line target. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
  return value.length <= maxTargetLength ? value : `${value.slice(0, maxTargetLength - 1)}…`;
}
