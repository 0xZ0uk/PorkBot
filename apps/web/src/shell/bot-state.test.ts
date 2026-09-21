import type { RunLiveness } from "@porkbot/contracts";
import { describe, expect, it } from "vitest";
import { stateFromLiveness, stateFromPending, stateFromRoster } from "./bot-state.ts";

function liveness(state: RunLiveness["state"]): RunLiveness {
  return { state, tool: null, heartbeatLagMs: 1_000, sinceProgressMs: 1_000 };
}

describe("the shell's bot state", () => {
  it("maps every run liveness onto the six words", () => {
    expect(stateFromLiveness(liveness("starting"))).toBe("working");
    expect(stateFromLiveness(liveness("thinking"))).toBe("working");
    expect(stateFromLiveness(liveness("working"))).toBe("working");
    expect(stateFromLiveness(liveness("waiting"))).toBe("waiting");
    expect(stateFromLiveness(liveness("stopping"))).toBe("stopped");
    expect(stateFromLiveness(liveness("stuck"))).toBe("stuck");
  });

  it("has no state to show for a thread with no live run", () => {
    expect(stateFromLiveness(null)).toBeNull();
  });

  it("is waiting only while something waits", () => {
    expect(stateFromPending(0)).toBeNull();
    expect(stateFromPending(2)).toBe("waiting");
  });

  it("gives every roster row a word: waiting, or idle", () => {
    expect(stateFromRoster(0)).toBe("idle");
    expect(stateFromRoster(3)).toBe("waiting");
  });
});
