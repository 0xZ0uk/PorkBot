import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
} from "@porkbot/adapter-kit";
import { ComputerEmulator, ComputerProviderError, NotificationEmulator } from "@porkbot/adapters";
import { describe, expect, it } from "vitest";
import { CANARY_BOT_ID } from "./policy.ts";
import { runCanary, sweepCanary } from "./runner.ts";

/**
 * The canary runner's proofs, all offline: the provider seam is the injected
 * `ComputerEmulator`, the notification seam is the E8 emulator's mailbox, and
 * the clock and run id are fixed. The real daemon and the real supervisor are
 * the integration tier's job; this file is about the runner's rules — teardown
 * on every path, one notification per failure, a billable kind refused without
 * a stated budget, and a sweep that claims only canary machines.
 */

interface ProviderOverrides {
  readonly ensure?: ((computer: ComputerRef) => Promise<ComputerStatus>) | undefined;
  readonly list?: (() => Promise<readonly ComputerStatus[]>) | undefined;
  readonly exec?: ((request: ComputerExecRequest) => Promise<ComputerExecResult>) | undefined;
  readonly destroy?: ((computer: ComputerRef) => Promise<void>) | undefined;
}

/** The seam with one method swapped, so a test can make a provider fail on cue. */
function withOverrides(base: ComputerProvider, overrides: ProviderOverrides): ComputerProvider {
  return {
    ensure: (computer) => (overrides.ensure ?? ((ref: ComputerRef) => base.ensure(ref)))(computer),
    status: (computer) => base.status(computer),
    stop: (computer) => base.stop(computer),
    list: () => (overrides.list ?? (() => base.list()))(),
    exec: (request) => (overrides.exec ?? ((req: ComputerExecRequest) => base.exec(req)))(request),
    snapshot: (computer) => base.snapshot(computer),
    restore: (computer: ComputerRef, snapshot: ComputerSnapshot) =>
      base.restore(computer, snapshot),
    destroy: (computer) =>
      (overrides.destroy ?? ((ref: ComputerRef) => base.destroy(ref)))(computer),
    validate: () => base.validate(),
  };
}

const userId = "0199c0de-0000-7000-8000-000000000001";

describe("a canary run that succeeds", () => {
  it("sweeps, boots, runs, makes the tool call and verifies the teardown", async () => {
    const provider = new ComputerEmulator();
    const report = await runCanary({
      provider,
      kind: "offline",
      runId: "canary-offline-ok",
    });

    expect(report.status).toBe("succeeded");
    expect(report.steps.map((step) => step.step)).toEqual([
      "sweep",
      "boot",
      "run",
      "tool_call",
      "teardown",
    ]);
    expect(report.steps.every((step) => step.status === "passed")).toBe(true);
    expect(report.teardownVerified).toBe(true);
    expect(report.orphansRemoved).toBe(0);
    expect(report.failure).toBeUndefined();
    expect(report.estimatedCostUsd).toBeUndefined();
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("removes a machine a previous run left behind and leaves a user's machine alone", async () => {
    const provider = new ComputerEmulator();

    await provider.ensure({ computerId: "canary-offline-leftover", botId: CANARY_BOT_ID });
    await provider.ensure({ computerId: "user-machine", botId: userId });

    const report = await runCanary({
      provider,
      kind: "offline",
      runId: "canary-offline-sweep",
    });

    expect(report.status).toBe("succeeded");
    expect(report.orphansRemoved).toBe(1);
    const held = await provider.list();

    expect(held).toHaveLength(1);
    expect(held[0]?.computer).toEqual({ computerId: "user-machine", botId: userId });
  });
});

describe("a canary run that fails", () => {
  it("notifies once through the E8 payload, with the link to logs, and still tears down", async () => {
    const base = new ComputerEmulator();
    const notifications = new NotificationEmulator();
    let executions = 0;
    const provider = withOverrides(base, {
      exec: async (request) => {
        executions += 1;

        if (executions >= 2) {
          throw new ComputerProviderError("gone", "the machine disappeared mid-run");
        }

        return await base.exec(request);
      },
    });

    const report = await runCanary({
      provider,
      kind: "offline",
      runId: "canary-offline-fail",
      notifier: notifications,
      logsUrl: "https://logs.example.invalid/runs/42",
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ step: "tool_call", kind: "gone" });
    expect(report.teardownVerified).toBe(true);
    await expect(base.list()).resolves.toEqual([]);

    expect(notifications.size).toBe(1);
    const delivered = notifications.last();

    expect(delivered?.title).toBe("Canary failed: offline");
    expect(delivered?.body).toContain("tool_call");
    expect(delivered?.body).toContain("canary-offline-fail");
    expect(delivered?.url).toBe("https://logs.example.invalid/runs/42");
    // The E8 payload is exactly the three fields, whatever a caller passed.
    expect(Object.keys(delivered ?? {}).sort()).toEqual(["body", "id", "sequence", "title", "url"]);
  });

  it("reports an unverified teardown instead of pretending the machine is gone", async () => {
    const base = new ComputerEmulator();
    const notifications = new NotificationEmulator();
    const provider = withOverrides(base, {
      destroy: async () => {
        throw new ComputerProviderError("rate_limited", "the provider refused the delete");
      },
    });

    const report = await runCanary({
      provider,
      kind: "offline",
      runId: "canary-offline-teardown",
      notifier: notifications,
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ step: "teardown", kind: "rate_limited" });
    expect(report.teardownVerified).toBe(false);
    expect(notifications.size).toBe(1);
    await expect(base.list()).resolves.toHaveLength(1);
  });

  it("stops at the sweep when the provider cannot be listed", async () => {
    const provider = withOverrides(new ComputerEmulator(), {
      list: async () => {
        throw new ComputerProviderError("timed_out", "the provider did not answer");
      },
    });

    const report = await runCanary({
      provider,
      kind: "offline",
      runId: "canary-offline-unreachable",
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ step: "sweep", kind: "timed_out" });
    expect(report.steps.map((step) => step.step)).toEqual(["sweep"]);
    expect(report.teardownVerified).toBe(false);
  });

  it("ends a run that outlives its ceiling and still tears the machine down", async () => {
    const base = new ComputerEmulator();
    const provider = withOverrides(base, {
      ensure: () => new Promise<never>(() => undefined),
    });

    const report = await runCanary({
      provider,
      kind: "offline",
      runId: "canary-offline-deadline",
      defaultCeilingMs: 20,
      teardownTimeoutMs: 500,
    });

    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({ step: "boot", kind: "timed_out" });
    expect(report.teardownVerified).toBe(true);
    await expect(base.list()).resolves.toEqual([]);
  });
});

describe("the canary budget gate", () => {
  it("never touches a billable provider without a stated budget", async () => {
    const provider = new ComputerEmulator();
    const notifications = new NotificationEmulator();

    const report = await runCanary({
      provider,
      kind: "cloud",
      billable: true,
      runId: "canary-cloud-unfunded",
      notifier: notifications,
    });

    expect(report.status).toBe("skipped");
    expect(report.skipReason).toBe("budget_not_stated");
    expect(report.steps).toEqual([]);
    await expect(provider.list()).resolves.toEqual([]);
    expect(notifications.size).toBe(0);
  });

  it("records the estimated spend of a funded run", async () => {
    const report = await runCanary({
      provider: new ComputerEmulator(),
      kind: "cloud",
      billable: true,
      monthlyBudgetUsd: 6,
      usdPerMinute: 0.002,
      runId: "canary-cloud-funded",
    });

    expect(report.status).toBe("succeeded");
    expect(report.budget).toEqual({
      kind: "ready",
      monthlyBudgetUsd: 6,
      usdPerMinute: 0.002,
      perRunCeilingMs: 5_806_451,
    });
    expect(report.estimatedCostUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("the sweep on its own", () => {
  it("destroys only canary machines and reports what it could not", async () => {
    const base = new ComputerEmulator();

    await base.ensure({ computerId: "canary-offline-a", botId: CANARY_BOT_ID });
    await base.ensure({ computerId: "canary-offline-b", botId: CANARY_BOT_ID });
    await base.ensure({ computerId: "user-machine", botId: userId });

    const refused: ComputerRef = { computerId: "canary-offline-b", botId: CANARY_BOT_ID };
    const provider = withOverrides(base, {
      destroy: async (computer) => {
        if (computer.computerId === refused.computerId) {
          throw new ComputerProviderError("rate_limited", "the provider refused the delete");
        }

        await base.destroy(computer);
      },
    });

    const swept = await sweepCanary(provider);

    expect(swept.removed.map((computer) => computer.computerId)).toEqual(["canary-offline-a"]);
    expect(swept.failed.map((entry) => entry.computer.computerId)).toEqual(["canary-offline-b"]);
    await expect(base.list()).resolves.toHaveLength(2);
  });
});
