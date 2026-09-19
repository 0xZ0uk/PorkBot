import { Clock, Effect } from "effect";
import { APPROVAL_POLL_INTERVAL_MS, DEFAULT_APPROVAL_TIMEOUT_MS } from "@porkbot/core";
import type { ApprovalStatus, ApprovalVote } from "@porkbot/core";
import { redact } from "@porkbot/logging";
import {
  ApprovalStoreError,
  GateTimeoutError,
  InvalidToolCallError,
  NotFoundError,
} from "./errors.ts";

/**
 * The durable approval gate (slice 5.7, PRD decision 13; audit P0 item 1).
 *
 * Approval is pending state, not a live socket. A gated tool call has a durable
 * `callId`, and this seam records a row for it before the run waits: a real
 * operator decision from anywhere — the same process, another process, a
 * browser reload later — lands on that row, and the wait observes the row. The
 * mailbox command path is a latency optimization on top of it, never the
 * mechanism: a decision that is not durable has not happened.
 *
 * `waitFor` therefore polls the store rather than subscribing to a connection.
 * The poll interval is a latency knob, not a correctness one — there is no
 * signal to lose — and it is what lets a decision taken in the API process
 * resolve a run executing in the worker without a shared bus. The deadline is
 * the store's, not the waiter's: when the store agrees the row is due,
 * `resolveTimeout` settles it with one compare-and-set, so a concurrent
 * operator decision wins atomically either way, and the gate answers the typed
 * `GateTimeoutError` that the run resolves to a deny (never a hang and never a
 * crash).
 *
 * The store is an interface, not a database call: `@porkbot/db` implements it
 * over the `approval` rows and this package's unit suite implements it in
 * memory, exactly as the tool dispatcher treats its ledger. A store failure is
 * the typed `ApprovalStoreError` — a call whose gate cannot be recorded must
 * not run — while a missing row stays the shared `NotFoundError`.
 *
 * `open` records the call's arguments through the shared redaction helper
 * before the row is written, so the operator reviews the same rendered payload
 * the transcript carries: secret-shaped fields are `[redacted]` and a string
 * beyond the log bound is `[truncated]`. The operator approves the action and
 * the tool executes the call it already holds; the gate is not a byte-exact
 * copy of an unattested payload, and a deployment that needs byte review must
 * keep gated payloads inside the inline bound.
 *
 * Wire events are the caller's side of the seam: `open` returns the row (whose
 * `expiresAt` is the durable deadline) and `waitFor` returns the settled row or
 * fails `GateTimeoutError`, and the run executor emits `approval.requested` /
 * `approval.resolved` from those records. The vocabulary and the reducer that
 * renders it live in `@porkbot/core`; keeping emission with the executor is
 * what lets a session allocate `seq` once and keeps this seam free of a
 * transport.
 */

/** What the run asks the store to hold open. The deadline is durable. */
export interface ApprovalRequest {
  readonly runId: string;
  readonly callId: string;
  readonly tool: string;
  /**
   * The tool call's arguments, as the operator will review them. They are
   * redacted by the gate before the row is written, so the durable decision
   * carries what the call would do without carrying a secret-shaped value.
   */
  readonly arguments: unknown;
  readonly expiresAt: Date;
}

/**
 * One durable approval row. `decidedBy` and `decidedAt` are the operator of
 * record and the instant the decision was recorded; a `timed_out` row has the
 * instant but no operator, because the system denied it. `arguments` is the
 * redacted tool-call payload the decision was made about.
 */
export interface ApprovalRecord {
  readonly id: string;
  readonly runId: string;
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly status: ApprovalStatus;
  readonly expiresAt: Date;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly reason: string | null;
}

/**
 * The gate's durable half, implemented by `@porkbot/db` and in memory by the
 * unit suite. `open` is idempotent — a restarted run reopens the same row and
 * waits on the original deadline — `resolveTimeout` is a guarded
 * compare-and-set that never fires before the row is due, and `find` is the
 * scoped read the wait polls.
 */
export interface ApprovalStore {
  open(request: ApprovalRequest): Promise<ApprovalRecord>;
  find(runId: string, callId: string): Promise<ApprovalRecord | undefined>;
  resolveTimeout(runId: string, callId: string): Promise<ApprovalRecord>;
}

/** One operator's act on a pending gate. */
export interface ApprovalVoteInput {
  readonly runId: string;
  readonly callId: string;
  readonly vote: ApprovalVote;
  readonly reason?: string;
}

/**
 * What a vote did. `applied` says whether this call performed the transition:
 * a second vote, or a vote that arrives after the deadline denied the gate,
 * observes the resolution without changing it, which is what makes concurrent
 * approve/deny resolve exactly once.
 */
export interface ApprovalVoteResult {
  readonly record: ApprovalRecord;
  readonly applied: boolean;
}

/**
 * The operator's history row. The approval table is keyed by a run, so the
 * history read joins the run's thread and bot once at the repository boundary
 * instead of making the console infer either relationship from an event.
 */
export interface ApprovalHistoryRecord extends ApprovalRecord {
  readonly botId: string;
  readonly threadId: string;
}

/** Filters for the operator's pending and historical approval list. */
export interface ApprovalListInput {
  readonly botId?: string | undefined;
  readonly runId?: string | undefined;
  readonly status?: ApprovalStatus | undefined;
}

/** The operator's durable half, for the API surface that records decisions. */
export interface ApprovalDecisions {
  decide(input: ApprovalVoteInput): Promise<ApprovalVoteResult>;
  listForRun(runId: string): Promise<readonly ApprovalRecord[]>;
  list(input?: ApprovalListInput): Promise<readonly ApprovalHistoryRecord[]>;
}

export interface ApprovalGateOptions {
  readonly runId: string;
  readonly store: ApprovalStore;
  /** Defaults to `DEFAULT_APPROVAL_TIMEOUT_MS` from `@porkbot/core`. */
  readonly timeoutMs?: number;
  /** Defaults to `APPROVAL_POLL_INTERVAL_MS` from `@porkbot/core`. */
  readonly pollIntervalMs?: number;
}

/** Everything a waiting gate can fail with; a timeout is the typed `TIMEOUT`. */
export type ApprovalGateError =
  ApprovalStoreError | NotFoundError | InvalidToolCallError | GateTimeoutError;

export interface ApprovalGateShape {
  /**
   * Records the pending request (or reopens the one a previous attempt left)
   * and returns the row to wait on. The returned `expiresAt` is the durable
   * deadline, so the caller emits the wire event from the store's answer rather
   * than from a timeout it guessed. A blank `callId` or `tool` is refused
   * before any write: the durable call id is what makes the gate addressable.
   */
  readonly open: (input: {
    readonly callId: string;
    readonly tool: string;
    readonly arguments: unknown;
  }) => Effect.Effect<ApprovalRecord, ApprovalStoreError | NotFoundError | InvalidToolCallError>;
  /**
   * Waits until the row is decided. Returns the settled record for an operator
   * decision and fails `GateTimeoutError` when the deadline won, in both cases
   * only after the store itself holds the resolution.
   */
  readonly waitFor: (record: ApprovalRecord) => Effect.Effect<ApprovalRecord, ApprovalGateError>;
}

/**
 * Builds the gate for one run. The gate is stateless — every wait reads the
 * store — so it holds no connection and no actor, and reopening one after a
 * worker restart resumes the same pending row.
 */
export function createApprovalGate(options: ApprovalGateOptions): ApprovalGateShape {
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `the approval timeout must be a positive integer, got ${String(timeoutMs)}`,
    );
  }

  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError(
      `the approval poll interval must be a positive integer, got ${String(pollIntervalMs)}`,
    );
  }

  const open: ApprovalGateShape["open"] = (input) =>
    Effect.gen(function* () {
      const blank = blankField(input);
      if (blank !== undefined) {
        return yield* Effect.fail(new InvalidToolCallError(blank));
      }

      const now = yield* Clock.currentTimeMillis;

      return yield* storeCall("open", () =>
        options.store.open({
          runId: options.runId,
          callId: input.callId,
          tool: input.tool,
          arguments: redact(input.arguments),
          expiresAt: new Date(now + timeoutMs),
        }),
      );
    });

  const waitFor: ApprovalGateShape["waitFor"] = (record) =>
    Effect.gen(function* () {
      for (;;) {
        const current = yield* storeCall("read", () =>
          options.store.find(record.runId, record.callId),
        );

        if (current === undefined) {
          return yield* Effect.fail(new NotFoundError("approval", record.callId));
        }

        if (current.status === "approved" || current.status === "denied") {
          return current;
        }

        if (current.status === "timed_out") {
          return yield* Effect.fail(new GateTimeoutError(current.callId));
        }

        const now = yield* Clock.currentTimeMillis;

        if (now >= current.expiresAt.getTime()) {
          const settled = yield* storeCall("time_out", () =>
            options.store.resolveTimeout(record.runId, record.callId),
          );

          if (settled.status === "timed_out") {
            return yield* Effect.fail(new GateTimeoutError(settled.callId));
          }

          if (settled.status === "approved" || settled.status === "denied") {
            return settled;
          }

          // The store still considers the row due in the future — the server
          // clock is authoritative — so keep polling rather than timing out
          // early or failing.
        }

        yield* Effect.sleep(pollIntervalMs);
      }
    });

  return { open, waitFor };
}

/**
 * Wraps a store call: the scoped not-found stays typed, and anything else from
 * the driver becomes the approval store's own failure. The underlying cause is
 * deliberately dropped — a database error can echo the values it was given.
 */
function storeCall<A>(
  operation: "open" | "read" | "time_out",
  run: () => Promise<A>,
): Effect.Effect<A, ApprovalStoreError | NotFoundError> {
  return Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof NotFoundError ? error : new ApprovalStoreError(operation)),
  });
}

/** The first identifier that cannot address a durable gate, if any. */
function blankField(input: {
  readonly callId: string;
  readonly tool: string;
}): "callId" | "tool" | undefined {
  if (input.callId.trim() === "") {
    return "callId";
  }

  if (input.tool.trim() === "") {
    return "tool";
  }

  return undefined;
}
