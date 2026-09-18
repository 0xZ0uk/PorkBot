import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_STATUSES,
  IllegalTransition,
  INITIAL_RUN_STATUS,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  assertTransition,
  canTransition,
  isActiveStatus,
  isRunStatus,
  isTerminalStatus,
  transition,
} from "./run-state.ts";
import type { RunStatus } from "./run-state.ts";

const expectedTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function isLegal(from: RunStatus, to: RunStatus): boolean {
  return expectedTransitions[from].includes(to);
}

const statePairs = RUN_STATUSES.flatMap((from) =>
  RUN_STATUSES.map((to) => ({
    from,
    to,
    legality: isLegal(from, to) ? "allows" : "rejects",
    legal: isLegal(from, to),
  })),
);

describe("run transition map", () => {
  it("is the declared table, keyed by every status", () => {
    expect(RUN_TRANSITIONS).toEqual(expectedTransitions);
  });

  it.each(statePairs)("$legality $from -> $to", ({ from, to, legal }) => {
    expect(canTransition(from, to)).toBe(legal);

    const outcome = transition(from, to);
    if (!legal) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(IllegalTransition);
        expect(outcome.error.from).toBe(from);
        expect(outcome.error.to).toBe(to);
      }
      expect(() => assertTransition(from, to)).toThrow(IllegalTransition);
      return;
    }

    expect(outcome).toEqual({ ok: true, status: to });
    expect(assertTransition(from, to)).toBe(to);
  });
});

describe("run state rules", () => {
  it("starts every run in a declared, active status", () => {
    expect(RUN_STATUSES).toContain(INITIAL_RUN_STATUS);
    expect(isActiveStatus(INITIAL_RUN_STATUS)).toBe(true);
  });

  it("treats exactly the statuses without outgoing transitions as terminal", () => {
    for (const status of RUN_STATUSES) {
      const terminal = expectedTransitions[status].length === 0;
      expect(isTerminalStatus(status)).toBe(terminal);
      expect(isActiveStatus(status)).toBe(!terminal);
    }
  });

  it("can cancel and can fail every active run", () => {
    for (const status of RUN_STATUSES.filter(isActiveStatus)) {
      expect(canTransition(status, "cancelled")).toBe(true);
      expect(canTransition(status, "failed")).toBe(true);
    }
  });

  it("suspends a running run on an approval gate and resumes it", () => {
    expect(canTransition("running", "waiting_approval")).toBe(true);
    expect(canTransition("waiting_approval", "running")).toBe(true);
  });

  it("never transitions a status to itself", () => {
    for (const status of RUN_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("never leaves a terminal status", () => {
    for (const status of RUN_STATUSES.filter(isTerminalStatus)) {
      for (const to of RUN_STATUSES) {
        expect(canTransition(status, to)).toBe(false);
      }
    }
  });

  it("lists exactly the active statuses, derived from the same rule", () => {
    expect([...ACTIVE_RUN_STATUSES]).toEqual(RUN_STATUSES.filter(isActiveStatus));
    expect([...ACTIVE_RUN_STATUSES]).toEqual(["queued", "running", "waiting_approval"]);
  });

  it("recognizes every declared status and nothing else", () => {
    for (const status of RUN_STATUSES) {
      expect(isRunStatus(status)).toBe(true);
    }

    for (const value of [undefined, null, 0, "", "RUNNING", "leased", "waiting_input"]) {
      expect(isRunStatus(value)).toBe(false);
    }
  });
});

describe("IllegalTransition", () => {
  it("is an Error that carries both statuses", () => {
    const error = new IllegalTransition("completed", "running");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("IllegalTransition");
    expect(error.message).toBe("Illegal run transition: completed -> running");
    expect(error.from).toBe("completed");
    expect(error.to).toBe("running");
  });
});
