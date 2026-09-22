import { cn } from "../lib/cn.ts";
import type { Approval } from "@porkbot/contracts";
import { connectorDangerousActions } from "@porkbot/core";
import type { ApprovalStatus, ApprovalVote } from "@porkbot/core";
import { BotAvatar, Button, Card, Icon } from "@porkbot/ui";
import type { IconName } from "@porkbot/ui";
import { useEffect, useState } from "react";

/**
 * The approval card (slice 13.9, story 40; design record, Conversation
 * grammar): the one rendering of a gate, in the transcript where the run
 * parked and in the queue that reads as one. It carries what the bot wants to
 * do, what the call touches, the consequence in one line and the live
 * deadline, with Approve and Deny as the only two real buttons.
 *
 * The card is a pure function of the approval's durable facts — the tool, the
 * redacted arguments, the status and the deadline — so the transcript's event
 * fold, the queue's list read and a reload all render the same card. The
 * deadline ticks client-side because it is the server's instant, not a client
 * timeout: when it passes, the card flips to the timeout's denial immediately
 * rather than waiting for the row to settle, because the store refuses a vote
 * after the deadline whether or not the run has noticed yet.
 *
 * The consequence is presentation, not policy. The gate's own summary carries
 * the class the worker computed, but it is not part of the durable row or the
 * event vocabulary, so the card names the destination the arguments carry —
 * the path, the URL, the credential, the command — and writes the one line
 * that follows from it. The classes the register already owns stay there: the
 * connector verbs come from `connectorDangerousActions`, so a tool that sends
 * is described as sending for the same reason it was gated.
 */

/** The bot identity the card paints beside the decision it belongs to. */
export interface ApprovalCardBot {
  readonly id: string;
  readonly name: string;
  readonly color?: string | null;
}

export interface ApprovalCardProps {
  readonly tool: string;
  /** The call's arguments: redacted from the durable row, raw from the stream. */
  readonly arguments: unknown;
  readonly status: ApprovalStatus;
  readonly expiresAt: string;
  readonly reason?: string | null | undefined;
  readonly decidedAt?: string | null | undefined;
  readonly bot?: ApprovalCardBot | null | undefined;
  /** The run the gate belongs to; the queue paints it, the transcript is in it. */
  readonly runId?: string | null | undefined;
  /** The deep link to the run's transcript, offered by the queue. */
  readonly transcriptHref?: string | null | undefined;
  /**
   * The clock the card renders against. The queue passes its own so the card
   * and the buckets share one tick; on its own the card ticks while it waits.
   */
  readonly now?: number | undefined;
  readonly onDecide?: ((vote: ApprovalVote) => Promise<Approval>) | undefined;
  /**
   * Whether the queue's redacted-arguments disclosure is drawn. The transcript
   * already renders the call's arguments one entry above, so it omits it.
   */
  readonly showArguments?: boolean | undefined;
}

const approvalTitleTone: Record<string, string> = {
  pending: "text-primary",
  approved: "text-success",
  denied: "text-destructive",
  timed_out: "text-destructive",
};

export function ApprovalCard({
  tool,
  arguments: callArguments,
  status,
  expiresAt,
  reason,
  decidedAt,
  bot,
  runId,
  transcriptHref,
  now,
  onDecide,
  showArguments = false,
}: ApprovalCardProps) {
  const [settled, setSettled] = useState<Approval | null>(null);
  const [busy, setBusy] = useState<ApprovalVote | null>(null);
  const [error, setError] = useState(false);
  // Ticks only when no caller-supplied clock is present: the queue owns one
  // clock for its buckets and the card; the transcript lets the card tick.
  const ticking = useApprovalClock(now === undefined && status === "pending");

  const current = settled ?? {
    status,
    expiresAt,
    reason: reason ?? null,
    decidedAt: decidedAt ?? null,
  };
  const clock = now ?? ticking;
  const live = liveApprovalStatus(current.status, current.expiresAt, clock);
  const pending = live === "pending";
  const description = describeApproval(tool, callArguments);

  useEffect(() => {
    setSettled(null);
    setBusy(null);
    setError(false);
  }, [status, expiresAt, reason, decidedAt]);

  async function decide(vote: ApprovalVote): Promise<void> {
    if (onDecide === undefined) {
      return;
    }

    setBusy(vote);
    setError(false);

    try {
      const updated = await onDecide(vote);
      setSettled(updated);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-2 flex flex-col gap-2 border-l-4 border-border pl-3" data-approval-state={live} data-approval-tool={tool}>
      <div className="flex flex-col items-start gap-1">
        <span className={cn("inline-flex items-center gap-1 text-meta font-semibold", approvalTitleTone[live])}>
          <Icon name={statusIcon(live)} size={14} />
          {statusTitle(live)}
        </span>
        <span className="tabular-nums text-meta font-medium text-muted-foreground">
          {pending ? (
            <time dateTime={current.expiresAt} title={approvalDateLabel(current.expiresAt)}>
              {approvalDeadlineLabel(current.expiresAt, clock)}
            </time>
          ) : current.decidedAt === null ? null : (
            approvalDateLabel(current.decidedAt)
          )}
        </span>
      </div>

      {bot === null || bot === undefined ? null : (
        <p className="m-0 flex items-center gap-1 text-meta text-muted-foreground">
          <BotAvatar id={bot.id} name={bot.name} color={bot.color ?? null} size={20} />
          <span>{bot.name}</span>
        </p>
      )}

      <p className="m-0 wrap-anywhere text-meta text-muted-foreground">{description.consequence}</p>

      <p className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
        <code className="font-mono text-code">{description.action}</code>
        {description.target === null ? null : (
          <code className="m-0 wrap-anywhere font-mono text-code text-muted-foreground">{description.target}</code>
        )}
        {runId === null || runId === undefined ? null : (
          <span className="text-meta text-muted-foreground">Run {runId}</span>
        )}
      </p>

      {pending && onDecide !== undefined ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={busy === "approve"}
            disabled={busy !== null}
            onClick={() => {
              void decide("approve");
            }}
          >
            Approve
          </Button>
          <Button
            variant="neutral"
            loading={busy === "deny"}
            disabled={busy !== null}
            onClick={() => {
              void decide("deny");
            }}
          >
            Deny
          </Button>
        </div>
      ) : null}

      {live === "timed_out" ? (
        <p className="m-0 wrap-anywhere text-body text-muted-foreground">The deadline passed, so the run was denied.</p>
      ) : current.reason === null || current.reason === "" ? null : (
        <p className="m-0 wrap-anywhere text-body text-muted-foreground">{current.reason}</p>
      )}

      {error ? (
        <p className="rounded-md border border-destructive bg-card p-2 text-foreground" role="alert">
          The decision could not be recorded. Try again.
        </p>
      ) : null}

      {transcriptHref === null || transcriptHref === undefined ? null : (
        <a className="text-body text-primary" href={transcriptHref}>
          Open transcript
        </a>
      )}

      {showArguments ? (
        <details className="">
          <summary>Arguments</summary>
          <pre className="mt-2 m-0 wrap-anywhere whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-code">{json(callArguments)}</pre>
        </details>
      ) : null}
    </Card>
  );
}

export interface ApprovalDescription {
  /** What the bot wants to run, named by the tool. */
  readonly action: string;
  /** What the call touches, or `null` when the arguments name nothing. */
  readonly target: string | null;
  /** The one line the decision turns on. */
  readonly consequence: string;
}

/**
 * The card's sentence, from the arguments the policy reads. The shapes are the
 * same ones `classifyDangerousAction` reads — a URL, a path, a credential
 * name, a command — because those are the argument names the tools use, and
 * the connector verbs are the register's own list.
 */
export function describeApproval(tool: string, callArguments: unknown): ApprovalDescription {
  const record = asRecord(callArguments);
  const url = readString(record, "url");
  const path = readString(record, "path");
  const name = readString(record, "name");
  const command = readString(record, "command");
  const origin = readString(record, "origin");

  if (url !== null) {
    return {
      action: tool,
      target: url,
      consequence: `Fetch ${url}. The request leaves this machine.`,
    };
  }

  if (path !== null) {
    return {
      action: tool,
      target: path,
      consequence: `Read or write ${path} on the bot's computer.`,
    };
  }

  if (name !== null) {
    return {
      action: tool,
      target: name,
      consequence:
        origin === null
          ? `Use the stored credential "${name}".`
          : `Use the stored credential "${name}" at ${origin}.`,
    };
  }

  if (command !== null) {
    return {
      action: tool,
      target: command,
      consequence: `Run ${command} on the bot's computer.`,
    };
  }

  const classes = connectorDangerousActions(tool);

  if (classes.includes("delete")) {
    return {
      action: tool,
      target: null,
      consequence: `Delete through the ${tool} tool. This cannot be undone.`,
    };
  }

  if (classes.includes("send")) {
    return {
      action: tool,
      target: null,
      consequence: `Send through the ${tool} tool. This leaves the network and cannot be unsent.`,
    };
  }

  return { action: tool, target: null, consequence: `Run the ${tool} tool.` };
}

/**
 * The status the card renders: a pending gate whose deadline has passed is the
 * timeout's denial already, because the store's compare-and-set refuses a vote
 * after `expires_at` and settles the row itself. Showing it before the run has
 * noticed is what keeps a gate from disappearing silently.
 */
export function liveApprovalStatus(
  status: ApprovalStatus,
  expiresAt: string,
  now: number,
): ApprovalStatus {
  if (status === "pending" && approvalIsDue(expiresAt, now)) {
    return "timed_out";
  }

  return status;
}

/** Whether the durable deadline has passed as of `now`. */
export function approvalIsDue(expiresAt: string, now: number): boolean {
  const deadline = Date.parse(expiresAt);

  return Number.isNaN(deadline) || deadline <= now;
}

/**
 * The deadline as the operator reads it: the remaining time, rounded up so a
 * fresh gate never says zero, in the largest two units that fit. An instant
 * the browser cannot parse reads as expired rather than as a guess.
 */
export function approvalDeadlineLabel(expiresAt: string, now: number): string {
  const deadline = Date.parse(expiresAt);

  if (Number.isNaN(deadline)) {
    return "Expired";
  }

  const remaining = deadline - now;

  if (remaining <= 0) {
    return "Expired";
  }

  return `${formatRemaining(remaining)} left`;
}

export function approvalDateLabel(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * One shared clock for the surfaces that render deadlines. It ticks only while
 * something is pending, so a settled history does not wake React every second.
 */
export function useApprovalClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);

    return () => clearInterval(timer);
  }, [active]);

  return now;
}

function statusTitle(status: ApprovalStatus): string {
  switch (status) {
    case "pending":
      return "Approval needed";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "timed_out":
      return "Timed out";
  }
}

function statusIcon(status: ApprovalStatus): IconName {
  switch (status) {
    case "pending":
      return "alert";
    case "approved":
      return "check";
    case "denied":
      return "close";
    case "timed_out":
      return "stop";
  }
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000);

  if (seconds < 60) {
    return `${String(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    const rest = seconds % 60;

    return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    const rest = minutes % 60;

    return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
  }

  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];

  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2) ?? String(value);
}
