import type { ToolCallSnapshot } from "@porkbot/core";

/**
 * One tool call in the console's timeline: which tool ran, with what
 * arguments, what came back, how long it took, and whether it failed.
 *
 * The row collapses to the four facts a reader scans — name, status, duration —
 * and expands to the JSON itself, because the arguments and results can be
 * arbitrarily large and most of the time nobody is auditing them. When the
 * result was too large for the event stream, the event carries a bounded
 * preview and a pointer; the row says so and links to the artifact route,
 * which resolves the whole value through the API. A failed call is marked in
 * the danger token and shows the error text the run recorded, which is where
 * the typed provider reason lives.
 *
 * The screen is router-free: the artifact link is a plain anchor to the
 * thread-scoped path, so the component renders the same in a test as in the
 * app, and a reload of the result is a normal document load.
 */

export interface ToolCallEntryProps {
  readonly threadId: string;
  /** The run the call belongs to; the artifact read is scoped by it. */
  readonly runId: string;
  readonly call: ToolCallSnapshot;
}

/** The artifact view's path: the same triple the API read is addressed by. */
export function toolResultPath(threadId: string, runId: string, callId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/tool-results/${encodeURIComponent(
    runId,
  )}/${encodeURIComponent(callId)}`;
}

export function ToolCallEntry({ threadId, runId, call }: ToolCallEntryProps) {
  const failed = call.status === "failed";
  const artifact = call.resultArtifact;

  return (
    <li className={failed ? "tool-call tool-call-failed" : "tool-call"}>
      <details className="tool-call-details">
        <summary className="tool-call-summary">
          <span className="tool-call-name">{call.tool}</span>
          <span
            className={failed ? "tool-call-status tool-call-status-failed" : "tool-call-status"}
          >
            {statusLabel(call)}
          </span>
          {call.durationMs === undefined ? null : (
            <span className="tool-call-duration muted">{formatDuration(call.durationMs)}</span>
          )}
        </summary>
        <dl className="tool-call-body">
          <dt>Arguments</dt>
          <dd>
            <pre className="tool-call-json">{json(call.arguments)}</pre>
          </dd>
          <dt>Result</dt>
          <dd>
            {failed ? (
              <p className="tool-call-error">{call.error ?? "The call failed."}</p>
            ) : call.status === "completed" ? (
              <pre className="tool-call-json">{json(call.result)}</pre>
            ) : (
              <p className="muted">{statusLabel(call)}.</p>
            )}
            {artifact === undefined ? null : (
              <a
                className="tool-call-artifact"
                href={toolResultPath(threadId, runId, artifact.callId)}
              >
                Full result ({formatBytes(artifact.bytes)})
              </a>
            )}
          </dd>
        </dl>
      </details>
    </li>
  );
}

/**
 * The call's state as one phrase. A pending gate is the run's state, not the
 * call's — the call is still only requested — so it takes precedence over
 * "Running", and a denial or deadline shows as the system's decision.
 */
function statusLabel(call: ToolCallSnapshot): string {
  if (call.status === "completed") {
    return "Completed";
  }

  if (call.status === "failed") {
    return "Failed";
  }

  switch (call.approval?.status) {
    case "pending":
      return "Waiting for approval";
    case "denied":
      return "Denied";
    case "timed_out":
      return "Timed out";
    default:
      return "Running";
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2) ?? String(value);
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function formatBytes(bytes: number): string {
  return bytes < 1_024 ? `${bytes} B` : `${(bytes / 1_024).toFixed(1)} KiB`;
}
