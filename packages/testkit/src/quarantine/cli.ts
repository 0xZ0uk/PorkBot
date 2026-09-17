#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import process from "node:process";
import { findRepoRoot } from "../paths.ts";
import {
  entryStatuses,
  formatEntries,
  ledgerFilePath,
  readLedger,
  validateLedger,
} from "./ledger.ts";
import type { QuarantineEntry } from "./ledger.ts";

/**
 * The quarantine check. It runs as its own CI job, before any test tier, for the
 * same reason the tiers are separate jobs: an expired quarantine must be a red
 * check with its own name, not a line in a test log.
 *
 * It reads nothing but the ledger and the tests it names, and it needs no
 * toolchain, which is what lets the CI job skip the install entirely:
 *
 *   node packages/testkit/src/quarantine/cli.ts check
 *   pnpm quarantine:check
 */

interface CliOptions {
  readonly repoRoot?: string;
  readonly ledgerFile?: string;
  readonly today?: string;
}

function usage(): string {
  return [
    "Usage: quarantine check [options]",
    "",
    "Options:",
    "  --repo-root <path>   Repository root (default: found by walking up for pnpm-workspace.yaml).",
    "  --ledger <path>      Ledger file (default: <repo-root>/quarantine.json).",
    "  --today <YYYY-MM-DD> Date to treat as today (default: the system clock).",
    "  --json               Print the parsed entries as JSON instead of a table.",
    "  --help               This text.",
  ].join("\n");
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (value === undefined) {
    throw new Error(`${flag} needs a value.`);
  }

  return value;
}

function parseArguments(argv: readonly string[]): {
  command: string;
  options: CliOptions;
  json: boolean;
  help: boolean;
} {
  const positional: string[] = [];
  let json = false;
  let help = false;
  const options: { repoRoot?: string; ledgerFile?: string; today?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--repo-root":
        options.repoRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--ledger":
        options.ledgerFile = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--today":
        options.today = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (argument !== undefined) {
          positional.push(argument);
        }
    }
  }

  return { command: positional[0] ?? "check", options, json, help };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function appendToJobSummary(markdown: string): void {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];

  if (summaryFile !== undefined && summaryFile !== "") {
    appendFileSync(summaryFile, `${markdown}\n`);
  }
}

export function run(argv: readonly string[]): number {
  const { command, options, json, help } = parseArguments(argv);

  if (help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (command !== "check") {
    process.stderr.write(`Unknown command "${command}".\n\n${usage()}\n`);
    return 2;
  }

  const repoRoot = options.repoRoot ?? findRepoRoot(process.cwd());
  const ledgerFile = options.ledgerFile ?? ledgerFilePath(repoRoot);
  const today = options.today ?? todayIso();
  const { ledger, errors: readErrors } = readLedger(ledgerFile);
  const errors = [...readErrors];

  if (readErrors.length === 0) {
    errors.push(...validateLedger(ledger, { repoRoot, today }));
  }

  const entries: QuarantineEntry[] = [...ledger.entries];

  process.stdout.write(
    json
      ? `${JSON.stringify({ today, ledgerFile, entries }, null, 2)}\n`
      : `${formatEntries(entries, today)}\n`,
  );

  const markdown = ["### Quarantine ledger", "", formatEntries(entries, today), ""];

  if (entries.length > 0) {
    markdown.push(
      "Every entry above is a test that will not run until its owner fixes it or extends the expiry. " +
        "An expired entry fails this check.",
      "",
    );
  }

  appendToJobSummary(markdown.join("\n"));

  for (const { entry, remainingDays, expiringSoon } of entryStatuses(entries, today)) {
    if (expiringSoon && remainingDays >= 0) {
      process.stdout.write(
        `::warning title=Quarantine expiring::${entry.id} ("${entry.test}") expires in ` +
          `${remainingDays} day(s) on ${entry.expires}. Owner: ${entry.owner}. ${entry.issue}\n`,
      );
    }
  }

  for (const error of errors) {
    process.stdout.write(`::error title=Quarantine ledger::${error}\n`);
  }

  if (errors.length > 0) {
    process.stderr.write(`\n${errors.length} problem(s) in ${ledgerFile}:\n`);
    for (const error of errors) {
      process.stderr.write(`  - ${error}\n`);
    }
    return 1;
  }

  process.stdout.write(
    `Quarantine ledger is valid: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, none expired ` +
      `as of ${today}.\n`,
  );

  return 0;
}

process.exitCode = run(process.argv.slice(2));
