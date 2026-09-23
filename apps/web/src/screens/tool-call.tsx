import type { Approval, Bot } from "@porkbot/contracts";
import type { ApprovalVote, ToolCallSnapshot } from "@porkbot/core";
import { Card, Icon } from "@porkbot/ui";
import { recordedArtifact, toolTarget } from "../run-outcome.ts";
import { ApprovalCard } from "./approval-card.tsx";

/**
 * One tool call in the console's timeline: which tool ran, what it acted on,
 * what came back, how long it took, and whether it failed.
 *
 * The row collapses to the four facts a reader scans — name, target, status,
 * duration — and expands to the JSON itself, because the arguments and results
 * can be arbitrarily large and most of the time nobody is auditing them. The
 * target is the one-line reading of the arguments the report card also uses,
 * so the card and the timeline name the same thing. When the result was too
 * large for the event stream, the event carries a bounded preview and a
 * pointer; the collapsed line links to the artifact route, which resolves the
 * whole value through the API, so the audit is one click from the row even
 * before it is expanded. A failed call is marked in the danger token on the
 * collapsed line and shows the error text the run recorded, which is where the
 * typed provider reason lives.
 *
 * A gated call (slice 13.9) renders the shared approval card beside the entry,
 * outside the disclosure, so the decision, its consequence and its deadline
 * stay on screen while the run is parked and after it settles — a resolved gate
 * that folded the row closed would be the silent disappearance the card exists
 * to prevent.
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
  /** The selected bot, for the identity on the approval card. */
  readonly bot?: Bot | undefined;
  /** The thread route wires this to the actor-scoped approval procedure. */
  readonly onApprovalDecision?:
    | ((input: {
        readonly runId: string;
        readonly callId: string;
        readonly vote: ApprovalVote;
        readonly reason?: string;
      }) => Promise<Approval>)
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
  bot,
  onApprovalDecision,
}: ToolCallEntryProps) {
  const failed = call.status === "failed";
  const approval = call.approval;
  const artifact = call.resultArtifact;
  const download = recordedArtifact(call.result);
  const target = toolTarget(call);

  return (
    <li
      className={
        failed
          ? "tool-call flex flex-col gap-1 border-destructive tool-call-failed"
          : "tool-call flex flex-col gap-1"
      }
      data-tool-call
    >
      <details className="tool-call-details" data-tool-call-details>
        <summary className="tool-call-summary flex cursor-pointer items-center gap-2 rounded-md p-1 hover:bg-accent">
          <span className="tool-call-name font-medium text-body" data-tool-call-name>
            {call.tool}
          </span>
          {target === null ? null : (
            <span className="tool-call-target break-words font-mono text-code text-muted-foreground">
              {target}
            </span>
          )}
          <span className="ml-auto flex flex-none items-baseline gap-2">
            <span
              className={
                failed
                  ? "tool-call-status text-meta uppercase tracking-wide text-muted-foreground text-destructive"
                  : "tool-call-status text-meta uppercase tracking-wide text-muted-foreground"
              }
              data-tool-call-status
            >
              {statusLabel(call)}
            </span>
            {artifact === undefined ? null : (
              <a
                className="tool-call-artifact text-body text-primary"
                href={toolResultPath(botId, threadId, runId, artifact.callId)}
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                Full result ({formatBytes(artifact.bytes)})
              </a>
            )}
            {call.durationMs === undefined ? null : (
              <span
                data-tool-call-duration
                className="tool-call-duration text-meta text-muted-foreground"
              >
                {formatDuration(call.durationMs)}
              </span>
            )}
            <span className="flex-none transition-transform" aria-hidden="true">
              <Icon name="chevron-right" size={14} />
            </span>
          </span>
        </summary>
        <dl className="mt-2 flex flex-col gap-1">
          <dt>Arguments</dt>
          <dd>
            <pre className="m-0 wrap-anywhere whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-code">
              {json(call.arguments)}
            </pre>
          </dd>
          <dt>Result</dt>
          <dd>
            {failed ? (
              <p className="m-0 wrap-anywhere text-destructive" data-tool-call-error>
                {call.error ?? "The call failed."}
              </p>
            ) : call.status === "completed" ? (
              <pre className="m-0 wrap-anywhere whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-code">
                {json(call.result)}
              </pre>
            ) : (
              <p className="text-muted-foreground">{statusLabel(call)}.</p>
            )}
          </dd>
        </dl>
      </details>
      {approval === undefined ? null : (
        <ApprovalCard
          tool={call.tool}
          arguments={call.arguments}
          status={approval.status}
          expiresAt={approval.expiresAt}
          reason={approval.reason ?? null}
          bot={bot ?? null}
          {...(onApprovalDecision === undefined
            ? {}
            : {
                onDecide: (vote: ApprovalVote) =>
                  onApprovalDecision({ runId, callId: call.callId, vote }),
              })}
        />
      )}
      {download === undefined ? null : (
        <Card className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
          <span
            className="grid size-7 flex-none place-items-center rounded-md bg-accent text-muted-foreground"
            aria-hidden="true"
          >
            <Icon name="download" size={14} />
          </span>
          <a
            className="tool-call-download text-body text-primary ml-auto flex-none"
            href={download.downloadPath}
            data-tool-call-download
          >
            Download {download.filename} ({formatBytes(download.sizeBytes)})
          </a>
        </Card>
      )}
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
