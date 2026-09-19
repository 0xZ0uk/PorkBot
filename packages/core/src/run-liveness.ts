/**
 * Run liveness: what a run is doing, whether it is still getting anywhere, and
 * when a hang is a hang (slice 6.10, PRD decision 33; story 22).
 *
 * A heartbeat proves a worker is alive; it does not prove the run is making
 * progress. This module separates the two facts and is the one place the
 * distinction is drawn, so the operator surface that renders it and the
 * watchdog that acts on it cannot disagree:
 *
 *   - Progress is an event. Every non-terminal run event advances the run's
 *     last-progress instant, and the step a reader sees is the kind of event
 *     that arrived last: the model is thinking, a tool is working, an approval
 *     is waiting. A run that emits nothing for longer than the stall threshold
 *     is stuck, however regularly its lease is renewed.
 *   - The assessment is a pure function of persisted state plus `now`. The same
 *     row therefore renders the same liveness live and after a reload, and the
 *     same function answers the console and the notification path.
 *   - Waiting and stopping are not hangs. A run parked on an operator's
 *     approval, or one whose stop was requested, is doing exactly what it
 *     should; only silence from a run that should be speaking is a stall.
 *
 * `createRunProgress` is the write-side rule: the worker feeds it the session's
 * events and stamps the result onto the run row on its next heartbeat, so the
 * durable row — not an in-memory guess — is what every reader assesses.
 */

import type { RunEvent } from "./run-events.ts";
import type { RunStatus } from "./run-state.ts";

/**
 * The step kinds a persisted run step can name. `stopping` and `stuck` are
 * assessments of a running run, not steps it reports, so they are deliberately
 * absent here: the tracker never writes them and the database check constraint
 * rejects them.
 */
export const RUN_STEP_KINDS = ["starting", "thinking", "working", "waiting"] as const;

export type RunStepKind = (typeof RUN_STEP_KINDS)[number];

/**
 * What the operator surface can show for an active run. The four step kinds
 * plus the two states only the assessment can know: the operator asked the run
 * to stop, or the run has stopped making progress.
 */
export const RUN_LIVENESS_STATES = [...RUN_STEP_KINDS, "stopping", "stuck"] as const;

export type RunLivenessState = (typeof RUN_LIVENESS_STATES)[number];

/**
 * How long a run may go without progress before it reads as stuck. It is
 * deliberately longer than a single tool's budget — the tool dispatcher already
 * refuses a registration whose `maxDurationMs` exceeds the lease TTL, so no
 * healthy step is silent for that long — and short enough that a hung model
 * call is visible within minutes rather than after the workday.
 */
export const RUN_STALL_THRESHOLD_SECONDS = 180;

export function isRunStepKind(value: unknown): value is RunStepKind {
  return typeof value === "string" && (RUN_STEP_KINDS as readonly string[]).includes(value);
}

/** The current step of a live run: what kind of work it is on, and on what. */
export interface RunStep {
  readonly kind: RunStepKind;
  /** The tool in flight or awaiting approval; `null` for the model's own turns. */
  readonly tool: string | null;
}

/**
 * What one heartbeat writes onto the run row. `progressed` is the honest
 * question — did anything happen since the previous beat? — rather than a
 * timestamp comparison, so the statement never has to reason about clock skew
 * between the worker that measured the idle time and the database that stores
 * it. `idleSeconds` is only meaningful when `progressed` is true.
 */
export interface RunProgressSnapshot {
  readonly progressed: boolean;
  readonly idleSeconds: number;
  readonly step: RunStep | null;
}

/**
 * The progress half of a live run: `note` is called once per session event and
 * `snapshot` is consumed by the lease heartbeat. A snapshot consumes the
 * progressed flag, because a beat is the only reader and a skipped beat is a
 * lost lease, not a retry.
 */
export interface RunProgress {
  note(event: RunEvent): void;
  snapshot(): RunProgressSnapshot;
}

export interface RunProgressOptions {
  /** Wall-clock source; injected so a test can move time without waiting. */
  readonly clock?: () => Date;
}

export function createRunProgress(options: RunProgressOptions = {}): RunProgress {
  const clock = options.clock ?? (() => new Date());
  let lastProgressAt = clock().getTime();
  let progressed = false;
  let step: RunStep | null = { kind: "starting", tool: null };
  let inFlight: { readonly callId: string; readonly tool: string } | null = null;

  return {
    note: (event) => {
      switch (event.type) {
        case "run.completed":
        case "run.failed":
        case "run.cancelled":
          // Terminal events end the progression rather than advance it; the
          // executor settles the row from the outcome that follows.
          step = null;
          inFlight = null;
          return;

        case "run.started":
          step = { kind: "starting", tool: null };
          break;

        case "token.delta":
        case "run.steered":
          step = { kind: "thinking", tool: null };
          break;

        case "tool.requested":
          inFlight = { callId: event.callId, tool: event.tool };
          step = { kind: "working", tool: event.tool };
          break;

        case "tool.completed":
        case "tool.failed":
          if (inFlight?.callId === event.callId) {
            inFlight = null;
          }

          step = { kind: "thinking", tool: null };
          break;

        case "approval.requested":
          step = {
            kind: "waiting",
            tool: inFlight?.callId === event.callId ? inFlight.tool : null,
          };
          break;

        case "approval.resolved":
          // An approved gate returns the run to the tool it was holding; a
          // denial or a timeout hands control back to the model.
          step =
            event.decision === "approved" && inFlight?.callId === event.callId
              ? { kind: "working", tool: inFlight.tool }
              : { kind: "thinking", tool: null };
          break;
      }

      lastProgressAt = clock().getTime();
      progressed = true;
    },

    snapshot: () => {
      const idleSeconds = Math.max(0, Math.floor((clock().getTime() - lastProgressAt) / 1_000));
      const result: RunProgressSnapshot = { progressed, idleSeconds, step };
      progressed = false;
      return result;
    },
  };
}

/**
 * The persisted half of a run's liveness, as the run row carries it. The
 * assessment takes this shape rather than the row itself so `@porkbot/core`
 * stays independent of the schema and a test can build one by hand.
 */
export interface RunLivenessSnapshot {
  readonly status: RunStatus;
  /**
   * The owner of the lease, or `null` while nobody holds the run. A queued run
   * has no executor yet and therefore no liveness to report; the console shows
   * nothing for it rather than inventing a step.
   */
  readonly leaseOwner: string | null;
  readonly stopRequestedAt: Date | null;
  readonly lastHeartbeatAt: Date | null;
  readonly lastProgressAt: Date | null;
  readonly currentStep: RunStepKind | null;
  readonly currentStepTool: string | null;
}

/** The assessment a console renders and a notification producer acts on. */
export interface RunLiveness {
  readonly state: RunLivenessState;
  readonly tool: string | null;
  /**
   * How long since the lease was last renewed. A fresh lag is health; a lag
   * past the heartbeat interval means the worker is overdue and the lease — not
   * the run — is the thing about to be reclaimed.
   */
  readonly heartbeatLagMs: number;
  /** How long since the last event; the number the stall decision reads. */
  readonly sinceProgressMs: number;
}

/**
 * The one assessment. It returns `null` for a run with nothing live to say: a
 * terminal run, a queued run nobody has claimed, or an active row whose lease
 * has already been released. Everything else carries a state, the step's tool,
 * the heartbeat lag and the progress age, computed against the caller's `now`.
 *
 * `stuck` outranks the step: a tool call that has been silent past the
 * threshold is the hang this module exists to surface, not work to be shown as
 * healthy. Waiting on an approval and answering a stop request are the two
 * exceptions — those are silences with a known reason.
 */
export function assessRunLiveness(
  snapshot: RunLivenessSnapshot,
  now: Date,
  stallThresholdSeconds: number = RUN_STALL_THRESHOLD_SECONDS,
): RunLiveness | null {
  if (snapshot.status !== "running" && snapshot.status !== "waiting_approval") {
    return null;
  }

  if (
    snapshot.leaseOwner === null ||
    snapshot.lastHeartbeatAt === null ||
    snapshot.lastProgressAt === null
  ) {
    return null;
  }

  const heartbeatLagMs = elapsedMs(snapshot.lastHeartbeatAt, now);
  const sinceProgressMs = elapsedMs(snapshot.lastProgressAt, now);
  const tool = snapshot.currentStepTool;

  if (snapshot.stopRequestedAt !== null) {
    return { state: "stopping", tool: null, heartbeatLagMs, sinceProgressMs };
  }

  if (snapshot.status === "waiting_approval" || snapshot.currentStep === "waiting") {
    return { state: "waiting", tool, heartbeatLagMs, sinceProgressMs };
  }

  if (sinceProgressMs > stallThresholdSeconds * 1_000) {
    return { state: "stuck", tool, heartbeatLagMs, sinceProgressMs };
  }

  return {
    state: snapshot.currentStep ?? "starting",
    tool: snapshot.currentStep === "working" ? tool : null,
    heartbeatLagMs,
    sinceProgressMs,
  };
}

function elapsedMs(from: Date, now: Date): number {
  return Math.max(0, now.getTime() - from.getTime());
}
