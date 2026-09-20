import { DEFAULT_TOOL_RESULT_LIMITS, summarizeToolResult } from "@porkbot/core";
import type { RunEvent, ToolResultLimits } from "@porkbot/core";
import { redact, redactString } from "@porkbot/logging";

/**
 * The durable and live halves of a run's event stream (slice 5.6).
 *
 * A `RunSession`'s events are consumed once, in order, and carry no cursor:
 * durability is this module's job. `RunEventSink` is the write half — one
 * append per event at the position the session already allocated — and
 * `@porkbot/db` implements it over the `event` table. `RunEventRecorder` is
 * the policy half: the single transform every consumer (the sink, the realtime
 * fanout, the SSE frames) runs an event through, so the live timeline and the
 * one replayed from durable rows are the same bytes.
 *
 * Three decisions belong to the recorder because they must be identical on
 * both sides of a reload:
 *
 *   - A tool call's arguments are redacted with the same helper that scrubs
 *     logs, so a secret-shaped argument is `[redacted]` in the live frame, the
 *     durable payload and any log line that carries the event (PRD stack
 *     decision 10).
 *   - An oversized tool result is replaced with a bounded preview and a
 *     `resultArtifact` pointer to the call's `external_effect` row, which holds
 *     the full value; it is never dropped silently (PRD decision 26's audit).
 *   - A settled tool call carries its wall-clock `durationMs`, measured from
 *     the `tool.requested` the recorder saw to the resolution, so the timeline
 *     answers "how long did it take" without joining another store.
 *
 * The recorder is per run and stateful only for those durations; a resolution
 * whose request this recorder never saw (a resumed stream, a foreign frame)
 * stays untimed rather than inventing a number. The clock and the limits are
 * injected so tests are deterministic.
 */

/** The write half of the run's event stream. `@porkbot/db` implements it. */
export interface RunEventSink {
  /**
   * Persists one event at the `seq` it already carries. Resolves when the row
   * is durable; a thread or run outside the sink's scope is the typed
   * `NotFoundError` and writes nothing.
   */
  append(event: RunEvent): Promise<void>;
}

/**
 * The read half of the run's event stream: the durable rows a rerun replays on
 * startup, oldest first. `afterSeq` is exclusive, exactly like the client
 * subscription's cursor, so the same walk serves a reconnect and a conversation
 * rebuild. `@porkbot/db` implements it; the rows are the same bytes the live
 * stream carried.
 */
export interface RunEventReader {
  listAfter(threadId: string, afterSeq: number, limit: number): Promise<readonly RunEvent[]>;
}

export interface RunEventRecorderOptions {
  /** Wall-clock milliseconds; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** The tool-result size policy; defaults to `@porkbot/core`'s. */
  readonly limits?: ToolResultLimits;
  /** Deep redaction for tool arguments; defaults to `@porkbot/logging`'s. */
  readonly redact?: (value: unknown) => unknown;
  /** Shape-scrubbing for failure text; defaults to `@porkbot/logging`'s. */
  readonly redactText?: (value: string) => string;
}

export interface RunEventRecorder {
  /** The event every durable and live consumer should see. */
  readonly record: (event: RunEvent) => RunEvent;
}

export function createRunEventRecorder(options: RunEventRecorderOptions = {}): RunEventRecorder {
  const clock = options.clock ?? Date.now;
  const limits = options.limits ?? DEFAULT_TOOL_RESULT_LIMITS;
  const redactValue = options.redact ?? redact;
  const redactText = options.redactText ?? redactString;

  // One entry per call the recorder has seen requested, replaced by its
  // settled duration once resolved so re-recording a resolution is stable.
  const calls = new Map<string, CallTiming>();

  const settle = (callId: string): number | undefined => {
    const timing = calls.get(callId);

    if (timing === undefined) {
      return undefined;
    }

    if ("durationMs" in timing) {
      return timing.durationMs;
    }

    const durationMs = Math.max(0, clock() - timing.startedAt);
    calls.set(callId, { durationMs });
    return durationMs;
  };

  return {
    record: (event) => {
      switch (event.type) {
        case "tool.requested": {
          if (!calls.has(event.callId)) {
            calls.set(event.callId, { startedAt: clock() });
          }

          return { ...event, arguments: redactValue(event.arguments) };
        }

        case "tool.completed": {
          const summary = summarizeToolResult(event.result, event.callId, limits);
          const durationMs = settle(event.callId);

          return {
            ...event,
            result: summary.result,
            ...(summary.artifact === undefined ? {} : { resultArtifact: summary.artifact }),
            ...(durationMs === undefined ? {} : { durationMs }),
          };
        }

        case "tool.failed": {
          const durationMs = settle(event.callId);

          return {
            ...event,
            error: redactText(event.error),
            ...(durationMs === undefined ? {} : { durationMs }),
          };
        }

        case "run.completed":
        case "run.failed":
        case "run.cancelled":
          calls.clear();
          return event;

        default:
          return event;
      }
    },
  };
}

type CallTiming = { readonly startedAt: number } | { readonly durationMs: number };
