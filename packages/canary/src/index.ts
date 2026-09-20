export const moduleInfo = {
  name: "@porkbot/canary",
  summary:
    "The scheduled live-provider canary: boot, run, tool call and teardown on a real Docker daemon or a real cloud provider, with a stated budget and an orphan sweep.",
} as const;

// The canary policy is pure: the budget arithmetic, the machine identity and
// the sweep's selection. The runner takes the `ComputerProvider` seam, so the
// unit tier drives it against the offline emulator and the integration tier
// drives it against real Docker. The CLI in src/cli.ts is the nightly
// workflow's entry point.
export {
  CANARY_BOT_ID,
  CANARY_MINIMUM_RUN_MS,
  CANARY_RUNS_PER_MONTH,
  canaryComputerRef,
  canaryRunId,
  estimatedCostUsd,
  formatDurationMs,
  formatUsd,
  planCanarySweep,
  resolveCanaryBudget,
} from "./policy.ts";
export type { CanaryBudget, CanaryBudgetInput, CanaryBudgetRefusal } from "./policy.ts";
export { canarySteps, DEFAULT_CANARY_CEILING_MS, runCanary, sweepCanary } from "./runner.ts";
export type {
  CanaryFailure,
  CanaryLogger,
  CanaryNotifier,
  CanaryReport,
  CanaryReportStatus,
  CanaryRunOptions,
  CanarySkipReason,
  CanaryStep,
  CanaryStepReport,
  CanaryStepStatus,
  CanarySweepResult,
} from "./runner.ts";
export { deliverCanaryNotification, resolveCanaryNotificationTarget } from "./notify.ts";
export type { CanaryNotificationEnvironment, CanaryNotificationTarget } from "./notify.ts";
