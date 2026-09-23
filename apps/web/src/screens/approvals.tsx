import type { Approval, Bot } from "@porkbot/contracts";
import type { ApprovalVote } from "@porkbot/core";
import { Field, Input, Select } from "@porkbot/ui";
import { useEffect, useMemo, useState } from "react";
import { ApprovalCard, liveApprovalStatus, useApprovalClock } from "./approval-card.tsx";

/**
 * The approval queue (slice 13.9, story 40; design record, Conversation
 * grammar).
 *
 * The queue is the same decision the transcript renders, mirrored: pending
 * gates come first, soonest deadline first, each one the shared card with its
 * consequence, its run and its two buttons. History follows with the same card
 * in its resolved state, so what was approved, denied or timed out reads as a
 * decision rather than as a table of raw records; the arguments stay behind
 * the card's disclosure because the audit trail still needs them.
 *
 * The buckets are live, not the durable row's status: a pending row whose
 * deadline has passed belongs to history already, because the store refuses a
 * vote after `expires_at` and settles it as `timed_out` itself. That is what
 * keeps a gate from sitting in the queue as though it were still answerable.
 */

export interface ApprovalsScreenProps {
  readonly approvals: readonly Approval[];
  readonly bots: readonly Bot[];
  readonly onDecision: (input: {
    readonly runId: string;
    readonly callId: string;
    readonly vote: ApprovalVote;
  }) => Promise<Approval>;
}

export function ApprovalsScreen({ approvals, bots, onDecision }: ApprovalsScreenProps) {
  const [botId, setBotId] = useState("");
  const [runId, setRunId] = useState("");
  const [status, setStatus] = useState<Approval["status"] | "">("");
  const [overrides, setOverrides] = useState<Record<string, Approval>>({});

  useEffect(() => {
    setOverrides({});
  }, [approvals]);

  const rows = useMemo(
    () => approvals.map((approval) => overrides[approvalKey(approval)] ?? approval),
    [approvals, overrides],
  );
  const now = useApprovalClock(rows.some((approval) => approval.status === "pending"));

  const visible = useMemo(
    () =>
      rows.filter((approval) => {
        if (botId !== "" && approval.botId !== botId) {
          return false;
        }

        if (runId.trim() !== "" && !approval.runId.includes(runId.trim())) {
          return false;
        }

        if (
          status !== "" &&
          liveApprovalStatus(approval.status, approval.expiresAt, now) !== status
        ) {
          return false;
        }

        return true;
      }),
    [rows, botId, now, runId, status],
  );

  const waiting = useMemo(
    () =>
      visible
        .filter(
          (approval) => liveApprovalStatus(approval.status, approval.expiresAt, now) === "pending",
        )
        .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt)),
    [visible, now],
  );

  const history = useMemo(
    () =>
      visible
        .filter(
          (approval) => liveApprovalStatus(approval.status, approval.expiresAt, now) !== "pending",
        )
        .sort((left, right) => resolvedAt(right) - resolvedAt(left)),
    [visible, now],
  );

  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  async function decide(approval: Approval, vote: ApprovalVote): Promise<Approval> {
    const updated = await onDecision({
      runId: approval.runId,
      callId: approval.callId,
      vote,
    });

    setOverrides((current) => ({ ...current, [approvalKey(approval)]: updated }));

    return updated;
  }

  function card(approval: Approval) {
    const bot = botsById.get(approval.botId) ?? null;

    return (
      <li key={approvalKey(approval)}>
        <ApprovalCard
          tool={approval.tool}
          arguments={approval.arguments}
          status={approval.status}
          expiresAt={approval.expiresAt}
          reason={approval.reason}
          decidedAt={approval.decidedAt}
          bot={bot}
          runId={approval.runId}
          now={now}
          transcriptHref={transcriptPath(approval)}
          showArguments
          {...(approval.status === "pending"
            ? { onDecide: (vote: ApprovalVote) => decide(approval, vote) }
            : {})}
        />
      </li>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3 gap-4">
      <header className="flex flex-col gap-1">
        <div>
          <h2>Approvals</h2>
          <p className="text-muted-foreground">
            Decide what a bot may do, and see what was decided.
          </p>
        </div>
      </header>

      <div className="flex flex-wrap gap-2" aria-label="Approval filters">
        <Field label="Bot">
          <Select
            aria-label="Filter by bot"
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
          >
            <option value="">All bots</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Run">
          <Input
            aria-label="Filter by run"
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            placeholder="Run id"
          />
        </Field>
        <Field label="Status">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as Approval["status"] | "")}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="denied">Denied</option>
            <option value="timed_out">Timed out</option>
          </Select>
        </Field>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">Nothing has needed a decision yet.</p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground">No approvals match these filters.</p>
      ) : (
        <>
          {waiting.length === 0 ? null : (
            <section className="flex flex-col gap-2" aria-labelledby="approvals-waiting">
              <h3 className="m-0 flex items-center gap-2 text-heading" id="approvals-waiting">
                Waiting for you
                <span className="inline-flex min-w-4.5 items-center justify-center rounded-full bg-primary px-0.5 text-meta text-primary-foreground">
                  {waiting.length}
                </span>
              </h3>
              <ol className="m-0 flex list-none flex-col gap-3 p-0">
                {waiting.map((approval) => card(approval))}
              </ol>
            </section>
          )}

          {history.length === 0 ? null : (
            <section className="flex flex-col gap-2" aria-labelledby="approvals-history">
              <h3 className="m-0 flex items-center gap-2 text-heading" id="approvals-history">
                History
              </h3>
              <ol className="m-0 flex list-none flex-col gap-3 p-0">
                {history.map((approval) => card(approval))}
              </ol>
            </section>
          )}
        </>
      )}
    </section>
  );
}

function approvalKey(approval: Pick<Approval, "runId" | "callId">): string {
  return `${approval.runId}:${approval.callId}`;
}

/** The transcript deep link the card offers: the run's own position. */
function transcriptPath(approval: Approval): string {
  return `/bots/${encodeURIComponent(approval.botId)}/threads/${encodeURIComponent(
    approval.threadId,
  )}?run=${encodeURIComponent(approval.runId)}`;
}

/**
 * When a row was resolved. A timed-out row carries the settling instant, and a
 * row whose deadline passed but is not yet settled reads its deadline, so the
 * history's order does not wait for the run to notice.
 */
function resolvedAt(approval: Approval): number {
  const decided = approval.decidedAt === null ? Number.NaN : Date.parse(approval.decidedAt);

  if (!Number.isNaN(decided)) {
    return decided;
  }

  const deadline = Date.parse(approval.expiresAt);

  return Number.isNaN(deadline) ? 0 : deadline;
}
