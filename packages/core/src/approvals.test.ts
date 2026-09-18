import { describe, expect, it } from "vitest";
import {
  APPROVAL_DECISIONS,
  APPROVAL_POLL_INTERVAL_MS,
  APPROVAL_STATUSES,
  APPROVAL_VOTES,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  isApprovalDecision,
  isApprovalStatus,
  isPendingApproval,
} from "./approvals.ts";

describe("the approval vocabulary", () => {
  it("resolves to exactly the non-pending statuses", () => {
    expect(APPROVAL_STATUSES.filter((status) => status !== "pending")).toEqual([
      ...APPROVAL_DECISIONS,
    ]);
  });

  it("recognizes every declared status and decision, and nothing else", () => {
    for (const status of APPROVAL_STATUSES) {
      expect(isApprovalStatus(status)).toBe(true);
    }

    for (const decision of APPROVAL_DECISIONS) {
      expect(isApprovalDecision(decision)).toBe(true);
    }

    for (const value of [undefined, null, 0, "", "PENDING", "approve", "expired", {}]) {
      expect(isApprovalStatus(value)).toBe(false);
      expect(isApprovalDecision(value)).toBe(false);
    }
  });

  it("treats only pending as unsettled", () => {
    expect(APPROVAL_STATUSES.filter(isPendingApproval)).toEqual(["pending"]);
  });

  it("names the two operator acts", () => {
    expect(APPROVAL_VOTES).toEqual(["approve", "deny"]);
  });
});

describe("the approval timeout policy", () => {
  it("polls many times inside the timeout, so a decision is seen long before the deadline", () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(APPROVAL_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(DEFAULT_APPROVAL_TIMEOUT_MS / APPROVAL_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(60);
  });
});
