import { fileDownloadPath } from "@porkbot/contracts";
import type { ToolCallSnapshot } from "@porkbot/core";
import { Button } from "@porkbot/ui";
import { useState } from "react";

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
 * The screen is router-free: the artifact links are plain anchors, so the
 * component renders the same in a test as in the app, and a reload of either
 * is a normal document load.
 *
 * A file-producing tool (slice 7.6) records its output through the storage
 * seam and answers with a download pointer; when the inline result carries
 * one, the row offers the file by name. The result is untrusted tool output,
 * so the row rebuilds the link from the artifact's id through the contract's
 * path builder instead of trusting a path it carries — a `//host` value would
 * otherwise render as a trusted external link — and a shape this build does
 * not recognise renders nothing rather than a broken link.
 */

export interface ToolCallEntryProps {
  readonly botId: string;
  readonly threadId: string;
  /** The run the call belongs to; the artifact read is scoped by it. */
  readonly runId: string;
  readonly call: ToolCallSnapshot;
  /** The thread route wires this to the actor-scoped approval procedure. */
  readonly onApprovalDecision?:
    | ((input: {
        readonly runId: string;
        readonly callId: string;
        readonly vote: "approve" | "deny";
        readonly reason?: string;
      }) => Promise<void>)
    | undefined;
}

/** The artifact view's path: the same triple the API read is addressed by. */
export function toolResultPath(
  botId: string,
  threadId: string,
  runId: string,
  callId: string,
): string {
  return `/bots/${encodeURIComponent(botId)}/threads/${encodeURIComponent(
    threadId,
  )}/tool-results/${encodeURIComponent(runId)}/${encodeURIComponent(callId)}`;
}

export function ToolCallEntry({
  botId,
  threadId,
  runId,
  call,
  onApprovalDecision,
}: ToolCallEntryProps) {
  const failed = call.status === "failed";
  const pending = call.approval?.status === "pending";
  const artifact = call.resultArtifact;
  const download = recordedArtifact(call.result);

  return (
    <li className={failed ? "tool-call tool-call-failed" : "tool-call"}>
      <details className="tool-call-details" open={pending}>
        <summary className="tool-call-summary">
          <span className="tool-call-name">{call.tool}</span>
          <span className="tool-call-run muted">Run {runId}</span>
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
                href={toolResultPath(botId, threadId, runId, artifact.callId)}
              >
                Full result ({formatBytes(artifact.bytes)})
              </a>
            )}
          </dd>
          {pending ? (
            <dd className="approval-controls-cell">
              <ApprovalControls
                runId={runId}
                callId={call.callId}
                expiresAt={call.approval.expiresAt}
                onDecision={onApprovalDecision}
              />
            </dd>
          ) : null}
        </dl>
      </details>
      {download === undefined ? null : (
        <a className="tool-call-artifact tool-call-download" href={download.downloadPath}>
          Download {download.filename} ({formatBytes(download.sizeBytes)})
        </a>
      )}
    </li>
  );
}

function ApprovalControls({
  runId,
  callId,
  expiresAt,
  onDecision,
}: {
  readonly runId: string;
  readonly callId: string;
  readonly expiresAt: string;
  readonly onDecision?: ToolCallEntryProps["onApprovalDecision"];
}) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState(false);

  async function decide(vote: "approve" | "deny"): Promise<void> {
    if (onDecision === undefined) {
      return;
    }

    setBusy(vote);
    setError(false);

    try {
      await onDecision({ runId, callId, vote });
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="approval-controls">
      <p className="approval-deadline muted">
        Waiting for your decision until {formatApprovalDeadline(expiresAt)}.
      </p>
      <div className="approval-buttons">
        <Button
          variant="primary"
          disabled={onDecision === undefined || busy !== null}
          onClick={() => {
            void decide("approve");
          }}
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button
          disabled={onDecision === undefined || busy !== null}
          onClick={() => {
            void decide("deny");
          }}
        >
          {busy === "deny" ? "Denying…" : "Deny"}
        </Button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          The decision could not be recorded. Try again.
        </p>
      ) : null}
    </div>
  );
}

/** The stored artifact a result carries, when it is a shape this build reads. */
function recordedArtifact(
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

function formatApprovalDeadline(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
