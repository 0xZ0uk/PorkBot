import { describe, expect, it } from "vitest";
import {
  CANARY_BOT_ID,
  CANARY_RUNS_PER_MONTH,
  canaryComputerRef,
  canaryRunId,
  estimatedCostUsd,
  formatDurationMs,
  formatUsd,
  planCanarySweep,
  resolveCanaryBudget,
} from "./policy.ts";

describe("the canary budget", () => {
  it("refuses a billable kind that has no stated budget", () => {
    expect(resolveCanaryBudget({})).toEqual({ kind: "refused", reason: "budget_not_stated" });
    expect(resolveCanaryBudget({ usdPerMinute: 0.001 })).toEqual({
      kind: "refused",
      reason: "budget_not_stated",
    });
    expect(resolveCanaryBudget({ monthlyBudgetUsd: 0, usdPerMinute: 0.001 })).toEqual({
      kind: "refused",
      reason: "budget_not_stated",
    });
  });

  it("refuses a stated budget with no stated rate", () => {
    expect(resolveCanaryBudget({ monthlyBudgetUsd: 5 })).toEqual({
      kind: "refused",
      reason: "rate_not_stated",
    });
  });

  it("refuses a budget whose per-run share is below a plausible run", () => {
    // $0.03 a month at $0.01/min is 3 minutes across 31 nights: six seconds a
    // night, which cannot boot, command and tear down a machine.
    expect(resolveCanaryBudget({ monthlyBudgetUsd: 0.03, usdPerMinute: 0.01 })).toEqual({
      kind: "refused",
      reason: "budget_too_small",
      perRunCeilingMs: 5_806,
    });
  });

  it("derives one night's ceiling from the month, the rate and the nights", () => {
    const budget = resolveCanaryBudget({ monthlyBudgetUsd: 6, usdPerMinute: 0.002 });

    expect(budget).toEqual({
      kind: "ready",
      monthlyBudgetUsd: 6,
      usdPerMinute: 0.002,
      runsPerMonth: CANARY_RUNS_PER_MONTH,
      // 6 / 0.002 = 3000 minutes a month, 31 nights, in milliseconds.
      perRunCeilingMs: 5_806_451,
    });
  });

  it("never lets a month of nights spend more than the stated budget", () => {
    const budget = resolveCanaryBudget({ monthlyBudgetUsd: 6, usdPerMinute: 0.002 });

    if (budget.kind !== "ready") {
      throw new Error("expected a ready budget");
    }

    const worstCase = estimatedCostUsd(
      budget.perRunCeilingMs * budget.runsPerMonth,
      budget.usdPerMinute,
    );

    expect(worstCase).toBeLessThanOrEqual(6);
  });
});

describe("the canary's cost estimate", () => {
  it("charges the run's wall time at the stated rate", () => {
    expect(estimatedCostUsd(60_000, 0.002)).toBe(0.002);
    expect(estimatedCostUsd(90_000, 0.002)).toBe(0.003);
    expect(estimatedCostUsd(1_000, 0.0005)).toBe(0.000008);
  });

  it("prints a dollar amount an operator can read", () => {
    expect(formatUsd(0)).toBe("$0.000000");
    expect(formatUsd(0.0123)).toBe("$0.012300");
  });

  it("prints a duration in the unit a report reads best", () => {
    expect(formatDurationMs(9_400)).toBe("9s");
    expect(formatDurationMs(90_000)).toBe("1.5m");
  });
});

describe("the canary's machine identity", () => {
  it("names the kind and the run in one handle", () => {
    const ref = canaryComputerRef("docker", canaryRunId("docker", "abc"));

    expect(ref).toEqual({
      computerId: "canary-docker-abc",
      botId: CANARY_BOT_ID,
      provider: "docker",
    });
  });
});

describe("the canary sweep's selection", () => {
  it("claims only machines the canary bot owns", () => {
    const held = [
      { computer: { computerId: "a", botId: CANARY_BOT_ID }, state: "running" as const },
      {
        computer: { computerId: "b", botId: "0199c0de-0000-7000-8000-000000000001" },
        state: "stopped" as const,
      },
      {
        computer: { computerId: "c", botId: CANARY_BOT_ID, provider: "daytona" },
        state: "running" as const,
      },
    ];

    expect(planCanarySweep(held)).toEqual([
      { computerId: "a", botId: CANARY_BOT_ID },
      { computerId: "c", botId: CANARY_BOT_ID, provider: "daytona" },
    ]);
  });

  it("selects nothing when the provider holds no canary machine", () => {
    expect(planCanarySweep([])).toEqual([]);
  });
});
