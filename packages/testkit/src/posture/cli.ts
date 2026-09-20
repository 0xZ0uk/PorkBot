#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import process from "node:process";
import { findRepoRoot } from "../paths.ts";
import { checkPosture } from "./policy.ts";

/**
 * The public-posture tier. Unlike the other checks it reads git history, so the
 * CI job fetches the full history (`fetch-depth: 0`) and runs this directly,
 * the same way the dependencies tier does:
 *
 *   node packages/testkit/src/posture/cli.ts check
 *   pnpm posture:check
 *
 * Findings never echo the matched value — the value may be the secret or the
 * personal data the audit exists to catch, and this output lands in public CI
 * logs. The rule id, the file and the commit are the actionable part.
 */

interface CliOptions {
  readonly repoRoot?: string;
  readonly refs?: readonly string[];
}

function usage(): string {
  return [
    "Usage: posture check [options]",
    "",
    "Options:",
    "  --repo-root <path>   Repository root (default: found by walking up for pnpm-workspace.yaml).",
    "  --refs <rev,rev>     Revisions to audit (default: every branch and remote-tracking ref).",
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
  help: boolean;
} {
  const positional: string[] = [];
  let help = false;
  const options: { repoRoot?: string; refs?: string[] } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--repo-root":
        options.repoRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--refs":
        options.refs = valueAfter(argv, index, argument)
          .split(",")
          .map((ref) => ref.trim())
          .filter((ref) => ref !== "");
        index += 1;
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

  return {
    command: positional[0] ?? "check",
    options: {
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...(options.refs === undefined ? {} : { refs: options.refs }),
    },
    help,
  };
}

function appendToJobSummary(markdown: string): void {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];

  if (summaryFile !== undefined && summaryFile !== "") {
    appendFileSync(summaryFile, `${markdown}\n`);
  }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function run(argv: readonly string[]): number {
  const { command, options, help } = parseArguments(argv);

  if (help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (command !== "check") {
    process.stderr.write(`Unknown command "${command}".\n\n${usage()}\n`);
    return 2;
  }

  const repoRoot = options.repoRoot ?? findRepoRoot(process.cwd());
  const report = checkPosture(repoRoot, options.refs);
  const { findings, stats, refs } = report;

  for (const finding of findings) {
    process.stdout.write(
      `::error title=Public posture::${finding.kind} ${finding.rule} at ${finding.subject}: ` +
        `${finding.summary}\n`,
    );
  }

  const scope =
    `Audited ${stats.files} posture file(s), ${stats.commits} commit(s), ${stats.blobs} text ` +
    `blob(s) (${formatMegabytes(stats.bytes)}) across ${refs.length} ref(s).`;

  appendToJobSummary(
    [
      "### Public posture",
      "",
      findings.length === 0
        ? `No secret or personal-data finding. ${scope}`
        : `${findings.length} finding(s); see the annotations on the failing step. ${scope}`,
      "",
    ].join("\n"),
  );

  if (findings.length > 0) {
    process.stderr.write(`\n${findings.length} public-posture finding(s):\n`);

    for (const finding of findings) {
      process.stderr.write(
        `  - ${finding.kind} ${finding.rule} at ${finding.subject}: ${finding.summary}\n`,
      );
    }

    return 1;
  }

  process.stdout.write(`Public posture holds. ${scope}\n`);

  return 0;
}

process.exitCode = run(process.argv.slice(2));
