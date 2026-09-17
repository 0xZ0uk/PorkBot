import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot, runVitest } from "./support/vitest-child.ts";

/**
 * The proofs in this file run vitest against fixtures in test/fixtures/flake.
 * Reading a config and asserting `retry: 2` proves nothing about behaviour, so
 * every claim this slice makes about retries, timeouts and quarantine is settled
 * by a real run whose exit code, output and attempt count are checked here.
 */

const scratch = mkdtempSync(path.join(tmpdir(), "porkbot-flake-proof-"));
const quarantineFixture = "packages/testkit/test/fixtures/flake/quarantine.fixture.ts";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function attemptsFile(name: string): string {
  const file = path.join(scratch, name);

  writeFileSync(file, "");

  return file;
}

function attempts(file: string): number {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

function writeLedger(name: string, entries: readonly unknown[]): string {
  const file = path.join(scratch, name);

  writeFileSync(file, JSON.stringify({ version: 1, entries }, null, 2));

  return file;
}

function daysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function quarantineEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "flake-0001",
    tier: "unit",
    file: quarantineFixture,
    test: "must be skipped while it is quarantined",
    owner: "@Z0uk",
    reason: "proving the ledger is applied at run time",
    issue: "https://github.com/0xZ0uk/PorkBot/issues/19",
    quarantinedOn: daysFromToday(-1),
    expires: daysFromToday(30),
    ...overrides,
  };
}

describe("retries", () => {
  it("save a transient e2e failure, and the retry is reported", async () => {
    const file = attemptsFile("e2e-attempts.txt");
    const run = await runVitest("vitest.e2e.config.ts", {
      env: { FLAKE_ATTEMPTS_FILE: file, GITHUB_ACTIONS: "true" },
    });

    expect(run.output).not.toContain("Unhandled");
    expect(run.code).toBe(0);
    // Failing once and then passing is the whole point: two attempts, one retry.
    expect(attempts(file)).toBe(2);
    expect(run.output).toContain("passed after 1 retry");
    expect(run.output).toContain("::warning file=");
    expect(run.output).toContain("| passes only once it is retried |");
  }, 120_000);

  it("do not touch the unit tier: the same failure is a failure there", async () => {
    const file = attemptsFile("unit-attempts.txt");
    const run = await runVitest("vitest.unit.config.ts", {
      env: { FLAKE_ATTEMPTS_FILE: file, GITHUB_ACTIONS: "true" },
    });

    expect(run.code).toBe(1);
    expect(attempts(file)).toBe(1);
    expect(run.output).not.toContain("passed after");
    expect(run.output).toContain("[flake] unit tier: 0 retried test(s)");
  }, 120_000);
});

describe("timeouts", () => {
  it("fail a hanging test instead of letting it block the tier", async () => {
    const started = Date.now();
    const run = await runVitest("vitest.timeout.config.ts", { timeoutMs: 60_000 });
    const elapsed = Date.now() - started;

    expect(run.code).toBe(1);
    expect(run.output).toMatch(/timed out/i);
    // The budget is one second, plus vitest's own startup: a run that took the
    // 60s ceiling would mean the timeout did not fire and the child was killed.
    expect(elapsed).toBeLessThan(45_000);
  }, 120_000);
});

describe("quarantine", () => {
  it("skips a quarantined test, and says who owns it and when it expires", async () => {
    const ledger = writeLedger("quarantine.json", [quarantineEntry()]);
    const run = await runVitest("vitest.quarantine.config.ts", {
      env: { FLAKE_LEDGER_FILE: ledger },
    });

    expect(run.code).toBe(0);
    expect(run.output).toContain("1 skipped");
    expect(run.output).toContain("@Z0uk");
    expect(run.output).toContain("proving the ledger is applied at run time");
    expect(run.output).toContain("[flake] unit tier: 0 retried test(s), 1 quarantined test(s)");
  }, 120_000);

  it("would fail without the entry, so the skip is doing real work", async () => {
    const ledger = writeLedger("empty.json", []);
    const run = await runVitest("vitest.quarantine.config.ts", {
      env: { FLAKE_LEDGER_FILE: ledger },
    });

    expect(run.code).toBe(1);
    expect(run.output).toContain("this test ran, so the quarantine ledger was not applied");
  }, 120_000);

  it("stops the tier when the entry is expired, instead of skipping the test forever", async () => {
    const ledger = writeLedger("expired.json", [quarantineEntry({ expires: daysFromToday(-1) })]);
    const run = await runVitest("vitest.quarantine.config.ts", {
      env: { FLAKE_LEDGER_FILE: ledger },
    });

    expect(run.code).toBe(1);
    expect(run.output).toContain("is not a usable quarantine ledger");
    expect(run.output).toContain("quarantine expired");
  }, 120_000);
});

describe("the proofs are running against this repository", () => {
  it("resolves the repository root and the fixtures from the testkit package", () => {
    expect(path.basename(repoRoot)).toBe("porkbot");
    expect(quarantineFixture.startsWith("packages/testkit/")).toBe(true);
  });
});
