#!/usr/bin/env node
import process from "node:process";
import { findRepoRoot } from "../paths.ts";
import { checkDocs, markdownFiles } from "./check.ts";

/**
 * The docs staleness check. It runs as its own CI job beside `quarantine` and
 * `dependencies`, for the same reason the tiers are separate jobs: a rotted
 * link or an undeclared environment name must be a red check with its own
 * name, not a line in a test log.
 *
 * It reads the repository's markdown, schemas and deployment template, and
 * needs no toolchain, which is what lets the CI job skip the install:
 *
 *   node packages/testkit/src/docs/cli.ts check
 *   pnpm docs:check
 */

interface CliOptions {
  readonly repoRoot?: string;
}

function usage(): string {
  return [
    "Usage: docs check [options]",
    "",
    "Options:",
    "  --repo-root <path>   Repository root (default: found by walking up for pnpm-workspace.yaml).",
    "  --json               Print the problems as JSON instead of a list.",
    "  --help               This text.",
  ].join("\n");
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
  const options: { repoRoot?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--repo-root": {
        const value = argv[index + 1];

        if (value === undefined) {
          throw new Error("--repo-root needs a value.");
        }

        options.repoRoot = value;
        index += 1;
        break;
      }
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
  const files = markdownFiles(repoRoot);
  const problems = checkDocs(repoRoot);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ files: files.map((file) => file.path), problems }, null, 2)}\n`,
    );
  } else if (problems.length === 0) {
    process.stdout.write(
      `Documentation is in sync: ${String(files.length)} files, every link and environment name checked.\n`,
    );
  } else {
    for (const problem of problems) {
      process.stdout.write(`::error title=Documentation::${problem}\n`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(`\n${String(problems.length)} documentation problem(s):\n`);

    for (const problem of problems) {
      process.stderr.write(`  - ${problem}\n`);
    }

    return 1;
  }

  return 0;
}

process.exitCode = run(process.argv.slice(2));
