import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Reporter, TestModule } from "vitest/node";
import { findRepoRoot } from "../paths.ts";
import { entriesFor, formatEntries, ledgerFilePath, readLedger } from "../quarantine/ledger.ts";
import type { QuarantineEntry, Tier } from "../quarantine/ledger.ts";

/**
 * Retries are allowed on the e2e tier, so they have to be visible. A retry that
 * only exists in a rerun nobody looks at is how a pipeline starts lying: the
 * check is green, the flake is still there, and the next person to touch that
 * test pays for it. This reporter prints every retried test as a GitHub
 * annotation and writes a table into the job summary, and it reports the
 * quarantined tests this tier skipped for the same reason.
 */

export interface FlakeReporterOptions {
  readonly tier?: Tier;
  readonly packageRoot?: string;
  readonly repoRoot?: string;
  readonly ledgerFile?: string;
  readonly today?: string;
}

export interface RetriedTest {
  /** The full test name, suite path included. */
  readonly name: string;
  /** Path relative to the repository root. */
  readonly file: string;
  readonly retryCount: number;
  readonly durationMs: number;
  readonly outcome: "passed" | "failed";
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Every test the runner had to retry, in file order, however it ended. */
export function collectRetriedTests(
  testModules: ReadonlyArray<TestModule>,
  repoRoot: string,
): RetriedTest[] {
  const retried: RetriedTest[] = [];

  for (const testModule of testModules) {
    for (const testCase of testModule.children.allTests()) {
      const diagnostic = testCase.diagnostic();
      const retryCount = diagnostic?.retryCount ?? 0;

      if (retryCount === 0) {
        continue;
      }

      retried.push({
        name: testCase.fullName,
        file: path.relative(repoRoot, testModule.moduleId),
        retryCount,
        durationMs: Math.round(diagnostic?.duration ?? 0),
        outcome: testCase.result().state === "passed" ? "passed" : "failed",
      });
    }
  }

  return retried;
}

/** GitHub workflow commands: these land as annotations on the pull request. */
export function annotationLines(retries: readonly RetriedTest[]): string[] {
  return retries.map(
    (test) =>
      `::warning file=${test.file},title=Retried test::` +
      `"${test.name}" ${test.outcome} after ${test.retryCount} retr${test.retryCount === 1 ? "y" : "ies"} ` +
      `(${test.durationMs}ms). A test that needs a retry is a test that needs fixing.`,
  );
}

/**
 * Workflow commands are only understood by GitHub's runner, and printing them
 * anywhere else is noise in somebody's terminal.
 */
export function inGitHubActions(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["GITHUB_ACTIONS"] === "true";
}

export interface FlakeReportInput {
  readonly tier: Tier;
  readonly retries: readonly RetriedTest[];
  readonly quarantined: readonly QuarantineEntry[];
  readonly today: string;
}

/** The markdown that goes into the job summary, or to stdout when there is none. */
export function flakeReportMarkdown({
  tier,
  retries,
  quarantined,
  today,
}: FlakeReportInput): string {
  const lines = [`### Flake report (${tier} tier)`, ""];

  if (retries.length === 0) {
    lines.push("No test was retried in this run.");
  } else {
    lines.push(`${retries.length} test(s) ran more than once:`);
    lines.push("");
    lines.push("| test | file | retries | outcome | time |");
    lines.push("| --- | --- | --- | --- | --- |");

    for (const test of retries) {
      lines.push(
        `| ${test.name} | \`${test.file}\` | ${test.retryCount} | ${test.outcome} | ${test.durationMs}ms |`,
      );
    }
  }

  lines.push("");
  lines.push("#### Quarantined in this tier");
  lines.push("");
  lines.push(formatEntries(quarantined, today));

  if (quarantined.length > 0) {
    lines.push("");
    lines.push(
      "Quarantined tests are skipped by `quarantine.json`, not deleted: an expired entry fails the " +
        "`quarantine` check, so each one has a deadline.",
    );
  }

  return lines.join("\n");
}

function appendToJobSummary(markdown: string): boolean {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];

  if (summaryFile === undefined || summaryFile === "") {
    return false;
  }

  appendFileSync(summaryFile, `${markdown}\n`);

  return true;
}

export class FlakeReporter implements Reporter {
  readonly #options: FlakeReporterOptions;

  constructor(options: FlakeReporterOptions = {}) {
    this.#options = options;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const tier = this.#options.tier ?? "unit";
    const packageRoot = path.resolve(this.#options.packageRoot ?? process.cwd());
    const today = this.#options.today ?? todayIso();

    let repoRoot = this.#options.repoRoot;
    let quarantined: QuarantineEntry[] = [];

    try {
      repoRoot ??= findRepoRoot(packageRoot);
      const { ledger, errors } = readLedger(this.#options.ledgerFile ?? ledgerFilePath(repoRoot));

      if (errors.length === 0) {
        quarantined = entriesFor(ledger, { tier, repoRoot, packageRoot });
      }
    } catch {
      // The quarantine half is a convenience here: the `quarantine` check in CI
      // is what enforces the ledger, and a missing ledger must not turn a test
      // run into an error from the reporter.
      quarantined = [];
    }

    const retries = collectRetriedTests(testModules, repoRoot ?? packageRoot);

    if (inGitHubActions()) {
      for (const line of annotationLines(retries)) {
        process.stdout.write(`${line}\n`);
      }
    }

    const markdown = flakeReportMarkdown({ tier, retries, quarantined, today });

    if (!appendToJobSummary(markdown)) {
      process.stdout.write(`${markdown}\n`);
    }

    process.stdout.write(
      `[flake] ${tier} tier: ${retries.length} retried test(s), ${quarantined.length} quarantined test(s).\n`,
    );
  }
}

export default FlakeReporter;
