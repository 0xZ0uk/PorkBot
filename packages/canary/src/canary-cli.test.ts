import { ComputerEmulator, NotificationEmulator } from "@porkbot/adapters";
import { describe, expect, it } from "vitest";
import { runCanaryCli } from "./cli.ts";
import type { CanaryCliContext } from "./cli.ts";
import { CANARY_BOT_ID } from "./policy.ts";

/**
 * The canary CLI's wiring, driven with injected seams: the offline provider,
 * the E8 notification emulator and captured output. The workflow calls this
 * CLI; the proofs that it routes a failure through the E8 provider, refuses a
 * billable kind without a budget and reaches the supervisor only when the
 * environment names one live here.
 */

interface Captured {
  readonly context: CanaryCliContext;
  readonly lines: string[];
  readonly errors: string[];
}

function capture(
  options: {
    readonly env?: Record<string, string | undefined>;
    readonly provider?: CanaryCliContext["provider"];
    readonly notifier?: CanaryCliContext["notifier"];
    readonly runId?: () => string;
  } = {},
): Captured {
  const lines: string[] = [];
  const errors: string[] = [];

  return {
    context: {
      env: options.env ?? {},
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      provider: options.provider,
      notifier: options.notifier,
      runId: options.runId,
    },
    lines,
    errors,
  };
}

function lastJson(lines: readonly string[]): unknown {
  const last = lines.at(-1);

  if (last === undefined) {
    throw new Error("the command printed nothing");
  }

  return JSON.parse(last) as unknown;
}

describe("canary run", () => {
  it("runs the named kind and exits green with a JSON report", async () => {
    const captured = capture({
      provider: new ComputerEmulator(),
      runId: () => "canary-offline-cli",
    });

    const code = await runCanaryCli(["run", "--kind", "offline"], captured.context);

    expect(code).toBe(0);
    const payload = lastJson(captured.lines) as {
      reports: { status: string; runId: string; teardownVerified: boolean }[];
    };

    expect(payload.reports).toHaveLength(1);
    expect(payload.reports[0]).toMatchObject({
      status: "succeeded",
      runId: "canary-offline-cli",
      teardownVerified: true,
    });
  });

  it("uses the supervisor's default kind when none is named", async () => {
    const provider = Object.assign(new ComputerEmulator(), {
      providers: () => Promise.resolve({ defaultKind: "offline", kinds: ["offline", "cloud"] }),
    });
    const captured = capture({ provider, runId: () => "canary-default-kind" });

    const code = await runCanaryCli(["run"], captured.context);

    expect(code).toBe(0);
    const payload = lastJson(captured.lines) as { reports: { kind: string }[] };

    expect(payload.reports[0]?.kind).toBe("offline");
  });

  it("exits red when a step fails", async () => {
    const base = new ComputerEmulator();
    const provider = Object.assign(base, {
      exec: () => Promise.reject(new Error("the command could not be sent")),
    });
    const captured = capture({ provider, runId: () => "canary-offline-red" });

    const code = await runCanaryCli(["run", "--kind", "offline"], captured.context);

    expect(code).toBe(1);
    const payload = lastJson(captured.lines) as { reports: { status: string }[] };

    expect(payload.reports[0]?.status).toBe("failed");
  });

  it("skips a billable kind without a stated budget and stays green", async () => {
    const captured = capture({
      provider: new ComputerEmulator(),
      runId: () => "canary-cloud-cli",
    });

    const code = await runCanaryCli(
      ["run", "--kind", "cloud", "--billable", "cloud"],
      captured.context,
    );

    expect(code).toBe(0);
    const payload = lastJson(captured.lines) as {
      reports: { status: string; skipReason: string }[];
    };

    expect(payload.reports[0]).toMatchObject({
      status: "skipped",
      skipReason: "budget_not_stated",
    });
  });

  it("refuses to guess a provider when the environment names no supervisor", async () => {
    const captured = capture();

    const code = await runCanaryCli(["run", "--kind", "offline"], captured.context);

    expect(code).toBe(1);
    expect(captured.errors.join("\n")).toContain("PORKBOT_SUPERVISOR_URL");
  });
});

describe("canary sweep", () => {
  it("removes a leftover canary machine and reports it", async () => {
    const provider = new ComputerEmulator();

    await provider.ensure({ computerId: "canary-offline-leftover", botId: CANARY_BOT_ID });

    const captured = capture({ provider });
    const code = await runCanaryCli(["sweep"], captured.context);

    expect(code).toBe(0);
    const payload = lastJson(captured.lines) as { removed: string[]; failed: unknown[] };

    expect(payload.removed).toEqual(["canary-offline-leftover"]);
    expect(payload.failed).toEqual([]);
    await expect(provider.list()).resolves.toEqual([]);
  });
});

describe("canary notify", () => {
  it("delivers the three-field payload through the injected E8 provider", async () => {
    const notifications = new NotificationEmulator();
    const captured = capture({ notifier: notifications });

    const code = await runCanaryCli(
      [
        "notify",
        "--title",
        "Nightly canary failed",
        "--body",
        "The supervisor did not start.",
        "--url",
        "https://logs.example.invalid/runs/7",
      ],
      captured.context,
    );

    expect(code).toBe(0);
    expect(notifications.last()).toMatchObject({
      title: "Nightly canary failed",
      body: "The supervisor did not start.",
      url: "https://logs.example.invalid/runs/7",
    });
  });

  it("refuses a notification with no title or body", async () => {
    const captured = capture({ notifier: new NotificationEmulator() });

    const code = await runCanaryCli(["notify", "--title", "only a title"], captured.context);

    expect(code).toBe(1);
    expect(captured.errors.join("\n")).toContain("--title and --body are required");
  });
});

describe("canary help", () => {
  it("prints the usage and exits green", async () => {
    const captured = capture();
    const code = await runCanaryCli(["help"], captured.context);

    expect(code).toBe(0);
    expect(captured.lines.join("\n")).toContain("Usage: canary");
  });

  it("rejects an unknown command", async () => {
    const captured = capture();
    const code = await runCanaryCli(["fly"], captured.context);

    expect(code).toBe(1);
    expect(captured.errors.join("\n")).toContain('unknown command "fly"');
  });
});
