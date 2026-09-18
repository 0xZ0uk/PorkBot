#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { findRepoRoot } from "../paths.ts";
import { diffLockfiles, formatLockfileDiff, parseLockfile } from "./lockfile.ts";
import { checkRepository, lockfileName, readLockfile } from "./policy.ts";

/**
 * The dependency tier. `check` is the gate: the register, the manifests, the
 * lockfile and every image reference must agree, and it reads files only, so it
 * runs before the install like the quarantine check does. `diff` is the
 * reviewer's view: on a pull request it writes the lockfile delta to the job
 * summary, so a dependency change is read as a diff rather than discovered
 * after merge.
 *
 *   node packages/testkit/src/dependencies/cli.ts check
 *   node packages/testkit/src/dependencies/cli.ts diff --base origin/main
 *   pnpm dependencies:check
 */

interface CliOptions {
  readonly repoRoot?: string;
  readonly base?: string;
}

function usage(): string {
  return [
    "Usage: dependencies <check|diff> [options]",
    "",
    "Commands:",
    "  check                Verify the register, manifests, lockfile and image references agree.",
    "  diff --base <rev>    Print the lockfile changes between <rev> and the working tree.",
    "",
    "Options:",
    "  --base <rev>         Revision to compare against (diff; default: origin/main).",
    "  --repo-root <path>   Repository root (default: found by walking up for pnpm-workspace.yaml).",
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
  const options: { repoRoot?: string; base?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--repo-root":
        options.repoRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--base":
        options.base = valueAfter(argv, index, argument);
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

  return { command: positional[0] ?? "check", options, help };
}

function appendToJobSummary(markdown: string): void {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];

  if (summaryFile !== undefined && summaryFile !== "") {
    appendFileSync(summaryFile, `${markdown}\n`);
  }
}

function runCheck(repoRoot: string): number {
  const { errors, register } = checkRepository(repoRoot);

  for (const error of errors) {
    process.stdout.write(`::error title=Dependency policy::${error}\n`);
  }

  appendToJobSummary(
    [
      "### Dependency policy",
      "",
      errors.length === 0
        ? `The register, manifests, lockfile and image references agree: ` +
          `${register.packages.length} package pin(s), ${register.images.length} image(s).`
        : `${errors.length} problem(s); see the annotations on the failing step.`,
      "",
    ].join("\n"),
  );

  if (errors.length > 0) {
    process.stderr.write(`\n${errors.length} dependency policy problem(s):\n`);

    for (const error of errors) {
      process.stderr.write(`  - ${error}\n`);
    }

    return 1;
  }

  process.stdout.write(
    `Dependency policy holds: ${register.packages.length} package pin(s), ` +
      `${register.images.length} image pin(s).\n`,
  );

  return 0;
}

function baseLockfileText(base: string, repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${base}:${lockfileName}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

function runDiff(repoRoot: string, base: string): number {
  const baseText = baseLockfileText(base, repoRoot);
  const label = baseText === undefined ? `${base} (no pnpm-lock.yaml there)` : base;
  const head = readLockfile(path.join(repoRoot, lockfileName));

  if (head.errors.length > 0) {
    for (const error of head.errors) {
      process.stdout.write(`::error title=Dependency policy::${error}\n`);
    }

    return 1;
  }

  const diff = diffLockfiles(
    baseText === undefined
      ? { importers: new Map(), packages: new Map() }
      : parseLockfile(baseText),
    head.lockfile,
  );
  const markdown = formatLockfileDiff(diff, label);

  process.stdout.write(`${markdown}\n`);
  appendToJobSummary(markdown);

  return 0;
}

export function run(argv: readonly string[]): number {
  const { command, options, help } = parseArguments(argv);

  if (help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const repoRoot = options.repoRoot ?? findRepoRoot(process.cwd());

  switch (command) {
    case "check":
      return runCheck(repoRoot);
    case "diff":
      return runDiff(repoRoot, options.base ?? "origin/main");
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${usage()}\n`);
      return 2;
  }
}

process.exitCode = run(process.argv.slice(2));
