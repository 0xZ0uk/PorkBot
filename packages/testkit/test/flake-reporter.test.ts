import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestModule } from "vitest/node";
import {
  FlakeReporter,
  annotationLines,
  collectRetriedTests,
  flakeReportMarkdown,
  inGitHubActions,
} from "../src/vitest/flake-reporter.ts";
import type { RetriedTest } from "../src/vitest/flake-reporter.ts";
import { parseLedgerValue } from "../src/quarantine/ledger.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scratch = mkdtempSync(path.join(tmpdir(), "porkbot-flake-report-"));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface FakeTest {
  readonly name: string;
  readonly retryCount: number;
  readonly state: "passed" | "failed" | "skipped";
  readonly duration?: number;
}

function fakeModule(moduleId: string, tests: readonly FakeTest[]): TestModule {
  const children = tests.map((test) => ({
    fullName: test.name,
    diagnostic: () => ({
      retryCount: test.retryCount,
      duration: test.duration ?? 12,
      slow: false,
      repeatCount: 0,
      startTime: 0,
      heap: undefined,
      flaky: test.retryCount > 0,
    }),
    result: () => ({ state: test.state }),
  }));

  return {
    moduleId,
    children: { allTests: () => children },
  } as unknown as TestModule;
}

function retried(overrides: Partial<RetriedTest> = {}): RetriedTest {
  return {
    name: "waits for the worker to become healthy",
    file: "apps/api/test/e2e/health.e2e.test.ts",
    retryCount: 1,
    durationMs: 340,
    outcome: "passed",
    ...overrides,
  };
}

describe("reading retries out of a finished run", () => {
  it("collects only the tests that ran more than once", () => {
    const modules = [
      fakeModule(path.join(repoRoot, "apps/api/test/e2e/health.e2e.test.ts"), [
        { name: "serves /healthz", retryCount: 0, state: "passed" },
        { name: "stops on SIGTERM", retryCount: 2, state: "passed", duration: 99 },
        { name: "skipped one", retryCount: 0, state: "skipped" },
      ]),
    ];

    expect(collectRetriedTests(modules, repoRoot)).toEqual([
      {
        name: "stops on SIGTERM",
        file: "apps/api/test/e2e/health.e2e.test.ts",
        retryCount: 2,
        durationMs: 99,
        outcome: "passed",
      },
    ]);
  });

  it("counts a test that only failed after its retries", () => {
    const modules = [
      fakeModule("/repo/packages/db/src/index.test.ts", [
        { name: "keeps failing", retryCount: 2, state: "failed" },
      ]),
    ];

    expect(collectRetriedTests(modules, "/repo")[0]?.outcome).toBe("failed");
  });
});

describe("what a reader sees", () => {
  it("annotates every retry as a warning on the pull request", () => {
    expect(annotationLines([retried()])).toEqual([
      "::warning file=apps/api/test/e2e/health.e2e.test.ts,title=Retried test::" +
        '"waits for the worker to become healthy" passed after 1 retry (340ms). ' +
        "A test that needs a retry is a test that needs fixing.",
    ]);
  });

  it("pluralises retries", () => {
    expect(annotationLines([retried({ retryCount: 2 })])[0]).toContain("after 2 retries");
  });

  it("says in words when nothing was retried, rather than staying silent", () => {
    const markdown = flakeReportMarkdown({
      tier: "unit",
      retries: [],
      quarantined: [],
      today: "2026-09-17",
    });

    expect(markdown).toContain("### Flake report (unit tier)");
    expect(markdown).toContain("No test was retried in this run.");
    expect(markdown).toContain("No test is quarantined.");
  });

  it("lists the retries and the quarantined tests in the same table", () => {
    const quarantined = parseLedgerValue({
      version: 1,
      entries: [
        {
          id: "flake-0001",
          tier: "e2e",
          file: "apps/api/test/e2e/health.e2e.test.ts",
          test: "serves /healthz",
          owner: "@Z0uk",
          reason: "the port is not always free on the runner",
          issue: "https://github.com/0xZ0uk/PorkBot/issues/19",
          quarantinedOn: "2026-09-01",
          expires: "2026-12-01",
        },
      ],
    }).ledger.entries;

    const markdown = flakeReportMarkdown({
      tier: "e2e",
      retries: [retried()],
      quarantined,
      today: "2026-09-17",
    });

    expect(markdown).toContain(
      "| waits for the worker to become healthy | `apps/api/test/e2e/health.e2e.test.ts` | 1 | passed | 340ms |",
    );
    expect(markdown).toContain("@Z0uk");
    expect(markdown).toContain("the port is not always free on the runner");
    expect(markdown).toContain("2026-12-01");
  });
});

describe("the reporter", () => {
  it("writes the table into the job summary when GitHub provides one", () => {
    const summary = path.join(scratch, "summary.md");
    const modules = [
      fakeModule(path.join(repoRoot, "apps/api/test/e2e/health.e2e.test.ts"), [
        { name: "waits for the worker", retryCount: 1, state: "passed" },
      ]),
    ];

    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    vi.stubEnv("GITHUB_ACTIONS", "true");

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    new FlakeReporter({
      tier: "e2e",
      packageRoot: repoRoot,
      repoRoot,
      ledgerFile: path.join(repoRoot, "quarantine.json"),
    }).onTestRunEnd(modules);

    expect(readFileSync(summary, "utf8")).toContain("### Flake report (e2e tier)");
    expect(written.join("")).toContain("::warning file=apps/api/test/e2e/health.e2e.test.ts");
    expect(written.join("")).toContain("[flake] e2e tier: 1 retried test(s)");
  });

  it("prints the table instead of a summary file when there is no runner", () => {
    vi.stubEnv("GITHUB_STEP_SUMMARY", "");
    vi.stubEnv("GITHUB_ACTIONS", "");

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    new FlakeReporter({
      tier: "unit",
      packageRoot: repoRoot,
      repoRoot,
      ledgerFile: path.join(repoRoot, "quarantine.json"),
    }).onTestRunEnd([]);

    expect(written.join("")).toContain("### Flake report (unit tier)");
    expect(written.join("")).not.toContain("::warning");
  });
});

describe("workflow commands", () => {
  it("are only emitted where a runner understands them", () => {
    expect(inGitHubActions({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(inGitHubActions({ GITHUB_ACTIONS: "false" })).toBe(false);
    expect(inGitHubActions({})).toBe(false);
  });
});
