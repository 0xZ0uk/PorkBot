import type { ComputerRef, ComputerStatus } from "@porkbot/adapter-kit";

/**
 * The scheduled canary's policy (slice 12.6, PRD testing decisions: "live-provider
 * checks are scheduled, not manual").
 *
 * The canary is the one check that leaves the repo's emulators and touches the
 * provider a self-hoster actually runs: a real Docker daemon, a real cloud
 * sandbox. Everything the runner decides — which machine is a canary machine,
 * what it may spend, when it refuses to run — is a pure function here, so the
 * expensive half is tested against the emulators and the arithmetic is tested
 * on its own.
 *
 * Cost is bounded before the first byte crosses the wire. A billable kind has
 * no default budget: it does not run until an operator states a monthly budget
 * and the provider's rate, and the per-run ceiling is the whole month divided
 * across the nightly runs. One run can then never spend more than its share,
 * and 31 nights can never exceed the stated budget — the arithmetic is the
 * enforcement, not a report written after the invoice arrives.
 */

/** The bot id every canary machine carries; the sweep's only claim, so a user's machine is never touched. */
export const CANARY_BOT_ID = "canary";

/** How many nightly runs a month's budget is divided across, worst case. */
export const CANARY_RUNS_PER_MONTH = 31;

/**
 * The shortest window in which a boot, two commands and a teardown plausibly
 * finish. A derived ceiling below this is not a budget, it is a misconfiguration
 * that would fail every night, so it is refused at plan time.
 */
export const CANARY_MINIMUM_RUN_MS = 120_000;

/** The default schedule a report states, in hours between runs. */
export const CANARY_RUN_INTERVAL_HOURS = 24;

export interface CanaryBudgetInput {
  /** The operator's stated monthly budget, in US dollars. */
  readonly monthlyBudgetUsd?: number | undefined;
  /** What the provider charges per machine-minute, in US dollars. */
  readonly usdPerMinute?: number | undefined;
  readonly runsPerMonth?: number | undefined;
  readonly minimumRunMs?: number | undefined;
}

export type CanaryBudgetRefusal = "budget_not_stated" | "rate_not_stated" | "budget_too_small";

export type CanaryBudget =
  | {
      readonly kind: "ready";
      readonly monthlyBudgetUsd: number;
      readonly usdPerMinute: number;
      readonly runsPerMonth: number;
      readonly perRunCeilingMs: number;
    }
  | {
      readonly kind: "refused";
      readonly reason: CanaryBudgetRefusal;
      /** The ceiling the stated numbers derived, when they derived one at all. */
      readonly perRunCeilingMs?: number | undefined;
    };

function isPositiveNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Turns the operator's stated budget into one run's ceiling. A missing budget
 * or rate is a refusal, not a default: silently choosing a number is how a
 * "cost-bounded" canary ends up unbounded.
 */
export function resolveCanaryBudget(input: CanaryBudgetInput): CanaryBudget {
  if (!isPositiveNumber(input.monthlyBudgetUsd)) {
    return { kind: "refused", reason: "budget_not_stated" };
  }

  if (!isPositiveNumber(input.usdPerMinute)) {
    return { kind: "refused", reason: "rate_not_stated" };
  }

  const runsPerMonth = input.runsPerMonth ?? CANARY_RUNS_PER_MONTH;
  const minimumRunMs = input.minimumRunMs ?? CANARY_MINIMUM_RUN_MS;
  const perRunCeilingMs = Math.floor(
    ((input.monthlyBudgetUsd / input.usdPerMinute) * 60_000) / runsPerMonth,
  );

  if (perRunCeilingMs < minimumRunMs) {
    return { kind: "refused", reason: "budget_too_small", perRunCeilingMs };
  }

  return {
    kind: "ready",
    monthlyBudgetUsd: input.monthlyBudgetUsd,
    usdPerMinute: input.usdPerMinute,
    runsPerMonth,
    perRunCeilingMs,
  };
}

/** What one run cost at the stated rate, rounded to a millionth of a dollar. */
export function estimatedCostUsd(durationMs: number, usdPerMinute: number): number {
  return Math.round((durationMs / 60_000) * usdPerMinute * 1_000_000) / 1_000_000;
}

/** A stable machine handle for one run of one kind; the run id is what makes it unique. */
export function canaryComputerRef(kind: string, runId: string): ComputerRef {
  return { computerId: runId, botId: CANARY_BOT_ID, provider: kind };
}

/** A run id that names the kind and the moment, so a report, a log line and a machine agree. */
export function canaryRunId(kind: string, suffix: string): string {
  return `canary-${kind}-${suffix}`;
}

/**
 * The sweep's selection: machines no live run owns. The canary's bot id is the
 * only thing it claims, and a real bot is a UUID, so a canary sweep can never
 * adopt a user's machine.
 */
export function planCanarySweep(held: readonly ComputerStatus[]): readonly ComputerRef[] {
  return held
    .filter((status) => status.computer.botId === CANARY_BOT_ID)
    .map((status) => status.computer);
}

/** A dollar amount an operator can read in a one-line notification. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

/** Milliseconds as minutes and seconds, for a report that an operator reads. */
export function formatDurationMs(value: number): string {
  const seconds = Math.round(value / 1_000);

  return seconds < 60 ? `${String(seconds)}s` : `${(seconds / 60).toFixed(1)}m`;
}
