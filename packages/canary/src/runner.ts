import { randomUUID } from "node:crypto";
import type {
  ComputerProvider,
  ComputerRef,
  OperatorNotification,
  ProviderFailureKind,
} from "@porkbot/adapter-kit";
import { isProviderFailure } from "@porkbot/adapter-kit";
import { quoteShellArgument } from "@porkbot/adapters";
import {
  canaryComputerRef,
  canaryRunId,
  estimatedCostUsd,
  formatUsd,
  planCanarySweep,
  resolveCanaryBudget,
} from "./policy.ts";

/**
 * The scheduled canary's runner (slice 12.6).
 *
 * One run proves the surface a self-hoster cannot test with an emulator: it
 * boots a machine through the provider seam, runs a command on it, makes the
 * round trip a tool call makes, and tears the machine down — then verifies the
 * teardown instead of trusting it. The provider is injected as the seam it is,
 * so the same runner is exercised against the offline emulator in the unit
 * tier and against a real supervisor (real Docker, real cloud) from the CLI.
 *
 * Two rules hold on every path, including failure and timeout:
 *
 *   - the machine is destroyed before the run settles, and the sweep that
 *     follows destroys anything an earlier crashed run left, so a canary night
 *     cannot become an orphaned-resource bill;
 *   - a failure is a report and a notification, never a thrown stack: the
 *     caller decides what a red canary means, and the report carries the step,
 *     the shared failure vocabulary's kind and the estimated spend.
 *
 * Failure classification reads only the shared vocabulary; a vendor message is
 * carried as detail and never parsed. The notification is exactly the E8
 * payload (title, body, link) and goes through the caller's `NotificationProvider`,
 * so a canary night that fails reaches the same operator surface as a failed run.
 */

/** The steps a report names, in the order they execute; `teardown` always runs. */
export const canarySteps = ["sweep", "boot", "run", "tool_call", "teardown"] as const;

export type CanaryStep = (typeof canarySteps)[number];

export type CanaryStepStatus = "passed" | "failed" | "skipped";

export interface CanaryStepReport {
  readonly step: CanaryStep;
  readonly status: CanaryStepStatus;
  readonly durationMs: number;
  readonly detail?: string | undefined;
  readonly failureKind?: ProviderFailureKind | "timed_out" | undefined;
}

export type CanaryReportStatus = "succeeded" | "failed" | "skipped";

export type CanarySkipReason = "budget_not_stated" | "rate_not_stated" | "budget_too_small";

export interface CanaryBudgetReport {
  readonly kind: "ready" | "refused";
  readonly monthlyBudgetUsd?: number | undefined;
  readonly usdPerMinute?: number | undefined;
  readonly perRunCeilingMs?: number | undefined;
  readonly reason?: CanarySkipReason | undefined;
}

export interface CanaryFailure {
  readonly step: CanaryStep;
  readonly kind?: ProviderFailureKind | "timed_out" | undefined;
  readonly detail: string;
}

export interface CanaryReport {
  readonly kind: string;
  readonly runId: string;
  readonly status: CanaryReportStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly steps: readonly CanaryStepReport[];
  readonly budget: CanaryBudgetReport | undefined;
  readonly estimatedCostUsd: number | undefined;
  readonly orphansRemoved: number;
  readonly teardownVerified: boolean;
  readonly skipReason?: CanarySkipReason | undefined;
  readonly failure?: CanaryFailure | undefined;
}

/** The E8 payload the runner delivers; the caller supplies the provider. */
export interface CanaryNotifier {
  deliver(notification: OperatorNotification): Promise<unknown>;
}

export interface CanaryLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CanaryRunOptions {
  readonly provider: ComputerProvider;
  /** The provider kind this run exercises, as the deployment configured it. */
  readonly kind: string;
  /** A billable kind does not run without a stated budget. */
  readonly billable?: boolean | undefined;
  readonly monthlyBudgetUsd?: number | undefined;
  readonly usdPerMinute?: number | undefined;
  /** Where the run's token file is written; the provider's home by default. */
  readonly workdir?: string | undefined;
  /** The link a failure notification carries: where this run's logs live. */
  readonly logsUrl?: string | undefined;
  readonly notifier?: CanaryNotifier | undefined;
  readonly logger?: CanaryLogger | undefined;
  readonly commandTimeoutMs?: number | undefined;
  readonly teardownTimeoutMs?: number | undefined;
  /** The ceiling for a kind that is not billed; billable kinds derive it from the budget. */
  readonly defaultCeilingMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly runId?: string | undefined;
}

/** A kind that is not billed still cannot run forever; this is its ceiling. */
export const DEFAULT_CANARY_CEILING_MS = 300_000;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 120_000;
const DEFAULT_WORKDIR = "/home/agent";

class CanaryDeadlineError extends Error {
  constructor(budgetMs: number) {
    super(`the canary exceeded its ${String(budgetMs)}ms ceiling`);
    this.name = "CanaryDeadlineError";
  }
}

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return isProviderFailure(error) ? (error.detail ?? message) : message;
}

function failureKindOf(error: unknown): ProviderFailureKind | "timed_out" | undefined {
  if (error instanceof CanaryDeadlineError) {
    return "timed_out";
  }

  return isProviderFailure(error) ? error.kind : undefined;
}

/** One attempt with a budget, so a wedged provider cannot outlive its ceiling. */
function withDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The losing promise may still settle; its rejection is already reported
      // by the deadline, so it must not become an unhandled rejection.
      work.catch(() => undefined);
      reject(new CanaryDeadlineError(budgetMs));
    }, budgetMs);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface CanarySweepResult {
  readonly removed: readonly ComputerRef[];
  readonly failed: readonly { readonly computer: ComputerRef; readonly detail: string }[];
}

/**
 * Destroys every machine the canary bot owns, whoever created it. The canary's
 * own run destroys its machine; this is what makes a night that crashed before
 * teardown cost nothing, and it is the only definition of "orphaned" the sweep
 * needs: a machine with the canary's bot id has no user behind it.
 */
export async function sweepCanary(
  provider: ComputerProvider,
  logger?: CanaryLogger,
): Promise<CanarySweepResult> {
  const removed: ComputerRef[] = [];
  const failed: { computer: ComputerRef; detail: string }[] = [];
  const held = await provider.list();

  for (const computer of planCanarySweep(held)) {
    try {
      await provider.destroy(computer);
      removed.push(computer);
      logger?.warn("destroyed a machine a previous canary run left behind", {
        computerId: computer.computerId,
      });
    } catch (error) {
      failed.push({ computer, detail: detailOf(error) });
    }
  }

  return { removed, failed };
}

/** True when the provider still holds the machine, whether running or parked. */
async function isStillHeld(provider: ComputerProvider, computer: ComputerRef): Promise<boolean> {
  const held = await provider.list();

  return held.some((status) => status.computer.computerId === computer.computerId);
}

function notificationFor(report: CanaryReport, logsUrl: string | undefined): OperatorNotification {
  const failure = report.failure;
  const reason =
    failure?.kind === undefined ? "an unexpected failure" : `the provider reported ${failure.kind}`;
  const cost =
    report.estimatedCostUsd === undefined
      ? ""
      : ` Estimated spend ${formatUsd(report.estimatedCostUsd)}.`;

  return {
    title: `Canary failed: ${report.kind}`,
    body:
      `The ${report.kind} live-provider canary failed at ${failure?.step ?? "run"} with ` +
      `${reason}. Run ${report.runId}.${cost}`,
    ...(logsUrl === undefined ? {} : { url: logsUrl }),
  };
}

/**
 * One canary run. The returned report is the whole story: every step with its
 * duration, the budget the run was allowed, the estimated spend, whether
 * teardown was verified and, on failure, the step and the shared-vocabulary
 * kind. A billable kind without a stated budget never reaches the provider; it
 * returns a `skipped` report, which is the enforcement of "the cloud canary
 * has a stated budget".
 */
export async function runCanary(options: CanaryRunOptions): Promise<CanaryReport> {
  const now = options.now ?? Date.now;
  const startedMs = now();
  const runId = options.runId ?? canaryRunId(options.kind, randomUUID());
  const computer = canaryComputerRef(options.kind, runId);
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const workdir = options.workdir ?? DEFAULT_WORKDIR;
  const budget = options.billable === true ? resolveCanaryBudget(options) : undefined;
  const steps: CanaryStepReport[] = [];
  let firstFailure: CanaryFailure | undefined;
  let teardownVerified = false;
  let orphansRemoved = 0;

  const budgetReport: CanaryBudgetReport | undefined =
    budget === undefined
      ? undefined
      : budget.kind === "ready"
        ? {
            kind: "ready",
            monthlyBudgetUsd: budget.monthlyBudgetUsd,
            usdPerMinute: budget.usdPerMinute,
            perRunCeilingMs: budget.perRunCeilingMs,
          }
        : {
            kind: "refused",
            reason: budget.reason,
            perRunCeilingMs: budget.perRunCeilingMs,
          };

  const finish = async (status: CanaryReportStatus, skipReason?: CanarySkipReason) => {
    const finishedMs = now();
    const report: CanaryReport = {
      kind: options.kind,
      runId,
      status,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      steps,
      budget: budgetReport,
      estimatedCostUsd:
        budget?.kind === "ready" && status !== "skipped"
          ? estimatedCostUsd(finishedMs - startedMs, budget.usdPerMinute)
          : undefined,
      orphansRemoved,
      teardownVerified,
      ...(skipReason === undefined ? {} : { skipReason }),
      ...(firstFailure === undefined ? {} : { failure: firstFailure }),
    };

    if (status === "failed" && options.notifier !== undefined) {
      try {
        await options.notifier.deliver(notificationFor(report, options.logsUrl));
      } catch (error) {
        options.logger?.error("the canary failure notification could not be delivered", {
          detail: detailOf(error),
        });
      }
    }

    return report;
  };

  if (budget !== undefined && budget.kind === "refused") {
    options.logger?.warn("the canary was refused before it touched the provider", {
      kind: options.kind,
      reason: budget.reason,
    });

    return await finish("skipped", budget.reason);
  }

  const ceilingMs =
    budget !== undefined && budget.kind === "ready"
      ? budget.perRunCeilingMs
      : (options.defaultCeilingMs ?? DEFAULT_CANARY_CEILING_MS);

  const step = async (
    name: CanaryStep,
    work: () => Promise<
      { detail?: string; failureKind?: ProviderFailureKind | "timed_out" } | undefined
    >,
    budgetMs = ceilingMs,
  ): Promise<boolean> => {
    const stepStartedMs = now();

    if (firstFailure !== undefined && name !== "teardown") {
      steps.push({ step: name, status: "skipped", durationMs: 0 });
      return false;
    }

    try {
      const outcome = (await withDeadline(Promise.resolve(work()), budgetMs)) ?? {};
      steps.push({
        step: name,
        status: "passed",
        durationMs: now() - stepStartedMs,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        ...(outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind }),
      });

      return true;
    } catch (error) {
      const failureKind = failureKindOf(error);
      const failure: CanaryFailure = {
        step: name,
        kind: failureKind,
        detail: detailOf(error),
      };

      firstFailure ??= failure;
      steps.push({
        step: name,
        status: "failed",
        durationMs: now() - stepStartedMs,
        detail: failure.detail,
        ...(failureKind === undefined ? {} : { failureKind }),
      });
      options.logger?.error("a canary step failed", {
        kind: options.kind,
        step: name,
        failureKind,
      });

      return false;
    }
  };

  options.logger?.info("canary run starting", {
    kind: options.kind,
    runId,
    ceilingMs: budget?.kind === "ready" ? budget.perRunCeilingMs : ceilingMs,
  });

  await step(
    "sweep",
    async () => {
      const swept = await sweepCanary(options.provider, options.logger);

      orphansRemoved = swept.removed.length;

      if (swept.failed.length > 0) {
        throw new Error(
          `the sweep could not destroy ${String(swept.failed.length)} leftover machine(s): ` +
            swept.failed.map((entry) => entry.computer.computerId).join(", "),
        );
      }

      return { detail: `${String(swept.removed.length)} leftover machine(s) removed` };
    },
    options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS,
  );

  if (firstFailure !== undefined && steps[0]?.step === "sweep" && steps[0].status === "failed") {
    // A provider that cannot be listed cannot be swept or verified; the run
    // stops here rather than reporting a teardown it never watched.
    return await finish("failed");
  }

  await step("boot", async () => {
    const status = await options.provider.ensure(computer);

    if (status.state !== "running") {
      throw new Error(`the provider booted the canary machine into "${status.state}"`);
    }

    return status.instanceId === undefined ? {} : { detail: status.instanceId };
  });

  await step("run", async () => {
    const tokenPath = `${workdir}/canary-token.txt`;
    const result = await options.provider.exec({
      computer,
      command: `mkdir -p ${quoteShellArgument(workdir)} && printf '%s' ${quoteShellArgument(runId)} > ${quoteShellArgument(tokenPath)}`,
      timeoutMs: commandTimeoutMs,
    });

    if (result.exitCode !== 0) {
      throw new Error(`the run command exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
    }

    return undefined;
  });

  await step("tool_call", async () => {
    const result = await options.provider.exec({
      computer,
      command: `cat ${quoteShellArgument(`${workdir}/canary-token.txt`)}`,
      timeoutMs: commandTimeoutMs,
    });

    if (result.exitCode !== 0) {
      throw new Error(`the tool call exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
    }

    if (result.stdout.trim() !== runId) {
      throw new Error("the tool call did not read back the token the run wrote");
    }

    return undefined;
  });

  await step(
    "teardown",
    async () => {
      await options.provider.destroy(computer);
      const status = await options.provider.status(computer);

      if (status.state !== "gone" || (await isStillHeld(options.provider, computer))) {
        throw new Error("the provider still holds the canary machine after destroy");
      }

      teardownVerified = true;

      return undefined;
    },
    options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS,
  );

  return await finish(firstFailure === undefined ? "succeeded" : "failed");
}
