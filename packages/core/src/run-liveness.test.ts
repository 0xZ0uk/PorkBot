import { describe, expect, it } from "vitest";
import {
  assessRunLiveness,
  createRunProgress,
  RUN_STALL_THRESHOLD_SECONDS,
  RUN_LIVENESS_STATES,
  RUN_STEP_KINDS,
} from "./run-liveness.ts";
import type { RunLivenessSnapshot } from "./run-liveness.ts";
import { RUN_EVENT_SCHEMA_VERSION } from "./run-events.ts";
import type { RunEvent } from "./run-events.ts";

/**
 * Run liveness (slice 6.10): the one assessment both the console and the
 * notification path read, and the progress rule the worker stamps onto the row.
 *
 * The boundaries are pinned here because everything downstream — a status line,
 * a stall notification, a watchdog pass — is a rendering of these numbers.
 */

const threadId = "thread-1";
const runId = "run-1";

function base(seq: number) {
  return { schemaVersion: RUN_EVENT_SCHEMA_VERSION, seq, threadId, runId } as const;
}

const events = {
  started: (seq = 1): RunEvent => ({ ...base(seq), type: "run.started" }),
  token: (seq: number): RunEvent => ({
    ...base(seq),
    type: "token.delta",
    messageId: "message-1",
    delta: "hello",
  }),
  steered: (seq: number): RunEvent => ({
    ...base(seq),
    type: "run.steered",
    messageId: "message-2",
    text: "focus",
  }),
  toolRequested: (seq: number, callId = "call-1", tool = "shell"): RunEvent => ({
    ...base(seq),
    type: "tool.requested",
    callId,
    tool,
    arguments: {},
  }),
  toolCompleted: (seq: number, callId = "call-1"): RunEvent => ({
    ...base(seq),
    type: "tool.completed",
    callId,
    result: "done",
  }),
  toolFailed: (seq: number, callId = "call-1"): RunEvent => ({
    ...base(seq),
    type: "tool.failed",
    callId,
    error: "boom",
  }),
  approvalRequested: (seq: number, callId = "call-1"): RunEvent => ({
    ...base(seq),
    type: "approval.requested",
    callId,
    expiresAt: "2026-09-18T12:00:00.000Z",
  }),
  approvalResolved: (
    seq: number,
    decision: "approved" | "denied" | "timed_out",
    callId = "call-1",
  ) => ({ ...base(seq), type: "approval.resolved", callId, decision }) as RunEvent,
  completed: (seq: number): RunEvent => ({ ...base(seq), type: "run.completed" }),
};

function snapshot(overrides: Partial<RunLivenessSnapshot> = {}): RunLivenessSnapshot {
  return {
    status: "running",
    leaseOwner: "worker-a",
    stopRequestedAt: null,
    lastHeartbeatAt: new Date(10_000),
    lastProgressAt: new Date(8_000),
    currentStep: "thinking",
    currentStepTool: null,
    ...overrides,
  };
}

const now = new Date(20_000);

describe("the run liveness assessment", () => {
  it("reports thinking with the heartbeat lag and the progress age", () => {
    expect(assessRunLiveness(snapshot(), now)).toEqual({
      state: "thinking",
      tool: null,
      heartbeatLagMs: 10_000,
      sinceProgressMs: 12_000,
    });
  });

  it("names the tool a working run is on", () => {
    const liveness = assessRunLiveness(
      snapshot({ currentStep: "working", currentStepTool: "shell" }),
      now,
    );

    expect(liveness).toMatchObject({ state: "working", tool: "shell" });
  });

  it("reads a parked approval as waiting, not as work or a hang", () => {
    const parked = assessRunLiveness(
      snapshot({
        status: "waiting_approval",
        currentStep: "waiting",
        currentStepTool: "shell",
        lastProgressAt: new Date(0),
      }),
      now,
    );

    expect(parked).toMatchObject({ state: "waiting", tool: "shell" });
  });

  it("reads a requested stop as stopping even when progress is long stale", () => {
    const stopping = assessRunLiveness(
      snapshot({ stopRequestedAt: new Date(1), lastProgressAt: new Date(0) }),
      now,
    );

    expect(stopping).toMatchObject({ state: "stopping", tool: null });
  });

  it("flags a run stuck past the threshold, not healthy, even while a tool is in flight", () => {
    const stalledAt = new Date(now.getTime() - (RUN_STALL_THRESHOLD_SECONDS + 1) * 1_000);

    expect(
      assessRunLiveness(
        snapshot({ currentStep: "working", currentStepTool: "shell", lastProgressAt: stalledAt }),
        now,
      ),
    ).toMatchObject({ state: "stuck", tool: "shell" });
  });

  it("keeps a run healthy at exactly the threshold and stuck one second beyond", () => {
    const atThreshold = new Date(now.getTime() - RUN_STALL_THRESHOLD_SECONDS * 1_000);
    const beyond = new Date(atThreshold.getTime() - 1_000);

    expect(assessRunLiveness(snapshot({ lastProgressAt: atThreshold }), now)?.state).toBe(
      "thinking",
    );
    expect(assessRunLiveness(snapshot({ lastProgressAt: beyond }), now)?.state).toBe("stuck");
  });

  it("has nothing to say about a terminal run or one nobody has claimed", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(assessRunLiveness(snapshot({ status }), now)).toBeNull();
    }

    expect(assessRunLiveness(snapshot({ status: "queued" }), now)).toBeNull();
    expect(assessRunLiveness(snapshot({ leaseOwner: null }), now)).toBeNull();
  });

  it("clamps a clock that reports a heartbeat in the future", () => {
    const liveness = assessRunLiveness(
      snapshot({ lastHeartbeatAt: new Date(30_000), lastProgressAt: new Date(30_000) }),
      now,
    );

    expect(liveness).toMatchObject({ heartbeatLagMs: 0, sinceProgressMs: 0 });
  });

  it("keeps the step and assessment vocabularies in step", () => {
    expect(RUN_LIVENESS_STATES).toEqual([...RUN_STEP_KINDS, "stopping", "stuck"]);
  });
});

describe("the run progress rule", () => {
  it("turns each event into the step it describes", () => {
    const at = new Date(0);
    const progress = createRunProgress({ clock: () => at });

    progress.note(events.started());
    expect(progress.snapshot().step).toEqual({ kind: "starting", tool: null });

    progress.note(events.token(2));
    expect(progress.snapshot().step).toEqual({ kind: "thinking", tool: null });

    progress.note(events.toolRequested(3));
    expect(progress.snapshot().step).toEqual({ kind: "working", tool: "shell" });

    progress.note(events.toolCompleted(4));
    expect(progress.snapshot().step).toEqual({ kind: "thinking", tool: null });

    progress.note(events.steered(5));
    expect(progress.snapshot().step).toEqual({ kind: "thinking", tool: null });
  });

  it("carries the in-flight tool into an approval and back on approval", () => {
    const progress = createRunProgress({ clock: () => new Date(0) });

    progress.note(events.toolRequested(1, "call-9", "web_fetch"));
    progress.note(events.approvalRequested(2, "call-9"));
    expect(progress.snapshot().step).toEqual({ kind: "waiting", tool: "web_fetch" });

    progress.note(events.approvalResolved(3, "approved", "call-9"));
    expect(progress.snapshot().step).toEqual({ kind: "working", tool: "web_fetch" });

    progress.note(events.approvalRequested(4, "call-9"));
    progress.note(events.approvalResolved(5, "denied", "call-9"));
    expect(progress.snapshot().step).toEqual({ kind: "thinking", tool: null });
  });

  it("waits without a tool when the approval names a call it never saw requested", () => {
    const progress = createRunProgress({ clock: () => new Date(0) });

    progress.note(events.approvalRequested(1, "call-foreign"));

    expect(progress.snapshot().step).toEqual({ kind: "waiting", tool: null });
  });

  it("stops progressing at a terminal event and reports no step", () => {
    const progress = createRunProgress({ clock: () => new Date(0) });

    progress.note(events.started());
    progress.snapshot();
    progress.note(events.completed(2));

    expect(progress.snapshot()).toMatchObject({ progressed: false, step: null });
  });

  it("measures idle time from the last non-terminal event", () => {
    let at = new Date(1_000);
    const progress = createRunProgress({ clock: () => at });

    expect(progress.snapshot()).toEqual({
      progressed: false,
      idleSeconds: 0,
      step: { kind: "starting", tool: null },
    });

    at = new Date(6_500);
    progress.note(events.token(1));
    expect(progress.snapshot()).toEqual({
      progressed: true,
      idleSeconds: 0,
      step: { kind: "thinking", tool: null },
    });

    at = new Date(15_200);
    expect(progress.snapshot()).toEqual({
      progressed: false,
      idleSeconds: 8,
      step: { kind: "thinking", tool: null },
    });
  });

  it("consumes the progressed flag once per snapshot, so a silent beat says so", () => {
    const progress = createRunProgress({ clock: () => new Date(0) });

    progress.note(events.token(1));

    expect(progress.snapshot().progressed).toBe(true);
    expect(progress.snapshot().progressed).toBe(false);
  });
});
