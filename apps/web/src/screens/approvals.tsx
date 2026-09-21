import type { Approval, Bot } from "@porkbot/contracts";
import { Button, Field, Input, Select } from "@porkbot/ui";
import { useEffect, useMemo, useState } from "react";

export interface ApprovalsScreenProps {
  readonly approvals: readonly Approval[];
  readonly bots: readonly Bot[];
  readonly onDecision: (input: {
    readonly runId: string;
    readonly callId: string;
    readonly vote: "approve" | "deny";
  }) => Promise<Approval>;
}

/**
 * The operator's approval inbox and audit history. Pending rows are expanded
 * because the action and its redacted arguments are the decision, while
 * resolved rows stay folded so a long history remains scannable.
 */
export function ApprovalsScreen({ approvals, bots, onDecision }: ApprovalsScreenProps) {
  const [botId, setBotId] = useState("");
  const [runId, setRunId] = useState("");
  const [status, setStatus] = useState<Approval["status"] | "">("");
  const [overrides, setOverrides] = useState<Record<string, Approval>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setOverrides({});
  }, [approvals]);

  const visible = useMemo(
    () =>
      approvals
        .map((approval) => overrides[approvalKey(approval)] ?? approval)
        .filter(
          (approval) =>
            (botId === "" || approval.botId === botId) &&
            (runId.trim() === "" || approval.runId.includes(runId.trim())) &&
            (status === "" || approval.status === status),
        ),
    [approvals, botId, overrides, runId, status],
  );

  async function decide(approval: Approval, vote: "approve" | "deny"): Promise<void> {
    const key = approvalKey(approval);
    setBusy(key);
    setError(false);

    try {
      const updated = await onDecision({ runId: approval.runId, callId: approval.callId, vote });
      setOverrides((current) => ({ ...current, [key]: updated }));
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="console approvals-screen">
      <header className="memory-header">
        <div>
          <h2>Approvals</h2>
          <p className="muted">Review dangerous actions and what happened to them.</p>
        </div>
      </header>

      <div className="approval-filters" aria-label="Approval filters">
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

      {error ? (
        <p className="form-error" role="alert">
          The decision could not be recorded. Try again.
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="muted">No approvals match these filters.</p>
      ) : (
        <ol className="approval-history">
          {visible.map((approval) => (
            <li
              key={approvalKey(approval)}
              className={
                approval.status === "pending"
                  ? "approval-record approval-record-pending"
                  : "approval-record"
              }
            >
              <details open={approval.status === "pending"}>
                <summary className="approval-summary">
                  <span className="approval-tool">{approval.tool}</span>
                  <span className="approval-status">{statusLabel(approval.status)}</span>
                  <span className="muted">Run {approval.runId}</span>
                </summary>
                <dl className="approval-body">
                  <dt>Action</dt>
                  <dd>{approval.tool}</dd>
                  <dt>Arguments</dt>
                  <dd>
                    <pre className="tool-call-json">{json(approval.arguments)}</pre>
                  </dd>
                  <dt>Run</dt>
                  <dd>
                    <a
                      href={`/threads/${encodeURIComponent(approval.threadId)}?run=${encodeURIComponent(approval.runId)}`}
                    >
                      Open transcript
                    </a>
                  </dd>
                  <dt>{approval.status === "timed_out" ? "Expired" : "Deadline"}</dt>
                  <dd>{formatApprovalDate(approval.expiresAt)}</dd>
                  {approval.decidedAt === null ? null : (
                    <>
                      <dt>Decided</dt>
                      <dd>{formatApprovalDate(approval.decidedAt)}</dd>
                    </>
                  )}
                  {approval.status === "pending" ? (
                    <dd className="approval-buttons">
                      <Button
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() => {
                          void decide(approval, "approve");
                        }}
                      >
                        {busy === approvalKey(approval) ? "Saving…" : "Approve"}
                      </Button>
                      <Button
                        disabled={busy !== null}
                        onClick={() => {
                          void decide(approval, "deny");
                        }}
                      >
                        Deny
                      </Button>
                    </dd>
                  ) : null}
                  {approval.reason === null ? null : (
                    <>
                      <dt>Reason</dt>
                      <dd>{approval.reason}</dd>
                    </>
                  )}
                </dl>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function approvalKey(approval: Pick<Approval, "runId" | "callId">): string {
  return `${approval.runId}:${approval.callId}`;
}

function statusLabel(status: Approval["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "timed_out":
      return "Timed out";
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2) ?? String(value);
}

function formatApprovalDate(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
