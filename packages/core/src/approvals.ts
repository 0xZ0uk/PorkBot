/**
 * The approval vocabulary and its timeout policy (PRD decision 13, story 40).
 *
 * An approval is durable pending state, not a live socket: a tool call carries
 * a durable `callId`, the run records a pending approval for it, and an
 * operator decision — or the deadline — resolves that row. This module owns the
 * closed vocabulary the database enum and every transport share, and the two
 * timings the gate is built from, so no caller invents a second timeout or a
 * second spelling of "denied".
 *
 * `pending` is a request awaiting an operator. The three resolved decisions are
 * distinct on purpose: `approved` and `denied` are operator acts and carry a
 * user of record, while `timed_out` is the system's resolution when nobody
 * answered — the PRD's `GateTimedOut -> deny` — and it must not render as
 * though a person declined.
 */

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "timed_out"] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The resolved half of {@link ApprovalStatus}: a row waiting on nobody. */
export const APPROVAL_DECISIONS = ["approved", "denied", "timed_out"] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** The two acts an operator can take. `deny` may carry a reason; `approve` may not. */
export const APPROVAL_VOTES = ["approve", "deny"] as const;

export type ApprovalVote = (typeof APPROVAL_VOTES)[number];

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === "string" && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

export function isPendingApproval(status: ApprovalStatus): boolean {
  return status === "pending";
}

/**
 * How long an unanswered gate holds a run before the timeout denies it. Ten
 * minutes is long enough for the operator to notice a notification and decide,
 * and short enough that a laptop-closed operator does not leave a run parked
 * for the working day. The run's lease outlives this by a wide margin, so the
 * gate is never the thing that expires a lease.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * How often a waiting gate re-reads the durable row for a decision. The row is
 * the channel — a decision taken anywhere, including in another process, is
 * visible on the next read — so this interval is a latency knob, not a
 * correctness one, and a lost wake-up is impossible because there is no signal
 * to lose.
 */
export const APPROVAL_POLL_INTERVAL_MS = 1_000;
