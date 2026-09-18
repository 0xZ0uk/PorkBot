import { describe, expect, it } from "vitest";
import {
  RUN_RECLAIM_FAILURES,
  decideReclaim,
  isResumableCheckpoint,
  reclaimFailureMessage,
} from "./run-recovery.ts";
import type { RunReclaimFailure } from "./run-recovery.ts";

describe("isResumableCheckpoint", () => {
  it("accepts any non-empty object as session state", () => {
    expect(isResumableCheckpoint({ step: 1 })).toBe(true);
    expect(isResumableCheckpoint({ compacted: { summary: "so far" }, nextSeq: 9 })).toBe(true);
  });

  it("refuses the empty object, which means there is no checkpoint yet", () => {
    expect(isResumableCheckpoint({})).toBe(false);
  });

  it("refuses values that are not a state object at all", () => {
    for (const value of [null, undefined, [], ["step"], "state", 7, true]) {
      expect(isResumableCheckpoint(value)).toBe(false);
    }
  });
});

describe("decideReclaim", () => {
  it("resumes a run whose checkpoint carries state", () => {
    expect(decideReclaim({ step: 3 })).toEqual({ resume: true });
  });

  it("fails a run that stopped before its first checkpoint", () => {
    expect(decideReclaim({})).toEqual({ resume: false, reason: "checkpoint_absent" });
  });

  it("fails a run whose checkpoint is not a state object", () => {
    for (const value of [null, [], "compacted", 42]) {
      expect(decideReclaim(value)).toEqual({ resume: false, reason: "checkpoint_unreadable" });
    }
  });

  it("distinguishes absent from unreadable, because the two read differently in a log", () => {
    expect(decideReclaim({}).resume).toBe(false);
    expect(decideReclaim(null).resume).toBe(false);
    expect(decideReclaim({})).not.toEqual(decideReclaim(null));
  });

  it("is total over the reclaim failure vocabulary", () => {
    const seen = new Set<RunReclaimFailure>();

    for (const value of [{}, null]) {
      const decision = decideReclaim(value);
      if (!decision.resume) {
        seen.add(decision.reason);
      }
    }

    expect([...seen].sort()).toEqual([...RUN_RECLAIM_FAILURES].sort());
  });
});

describe("reclaimFailureMessage", () => {
  it("gives every reason an operator-safe sentence", () => {
    for (const reason of RUN_RECLAIM_FAILURES) {
      const message = reclaimFailureMessage(reason);

      expect(message.length).toBeGreaterThan(0);
      expect(message.endsWith(".")).toBe(true);
    }
  });
});
