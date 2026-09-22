#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { findRepoRoot } from "../paths.ts";
import {
  builtServiceImages,
  imageBudgetsFileName,
  imageBudgetsFilePath,
  readBudgets,
} from "./budgets.ts";
import type { ImageBudget } from "./budgets.ts";
import { formatVerdictTable, judgeImage, readImageSize, verdictFailures } from "./measure.ts";
import type { BudgetVerdict, CommandRunner } from "./measure.ts";

/**
 * The size budget check. CI runs it in the integration job right after
 * `pnpm stack:up`, because that is where every service image is already built:
 * the check measures each one against `image-budgets.json`, writes the table to
 * the job summary so the sizes are on the pull request, and fails when one grew
 * past its ceiling or when the budgets and the built images have drifted apart.
 *
 *   node packages/testkit/src/image-sizes/cli.ts check
 *   pnpm image-sizes:check
 */

interface CliOptions {
  readonly repoRoot?: string;
  readonly tag?: string;
}

function usage(): string {
  return [
    "Usage: image-sizes check [options]",
    "",
    "Options:",
    "  --tag <tag>          Image tag to measure (default: local, the tag `pnpm stack:up` builds).",
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
  const options: { repoRoot?: string; tag?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--repo-root":
        options.repoRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--tag":
        options.tag = valueAfter(argv, index, argument);
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

const defaultRunner: CommandRunner = (command, args) =>
  execFileSync(command, [...args], { encoding: "utf8" });

function check(
  repoRoot: string,
  tag: string,
  run: CommandRunner,
): { failures: string[]; verdicts: BudgetVerdict[] } {
  const budgetsFile = imageBudgetsFilePath(repoRoot);
  const { register, errors } = readBudgets(budgetsFile);
  const failures = [...errors];

  const deployComposeText = (() => {
    try {
      return readFileSync(path.join(repoRoot, "deploy", "compose.yaml"), "utf8");
    } catch {
      failures.push("deploy/compose.yaml is missing; it is where the built services are declared.");
      return "";
    }
  })();

  const built = deployComposeText === "" ? [] : builtServiceImages(deployComposeText);
  const budgetsByName = new Map<string, ImageBudget>(
    register.images.map((entry) => [entry.name, entry]),
  );

  for (const image of built) {
    if (!budgetsByName.has(image.name)) {
      failures.push(
        `${image.service} builds ${image.name} (target ${image.target}) but ${imageBudgetsFileName} ` +
          "states no budget for it. A built image without a ceiling is the gap this file exists to close.",
      );
    }
  }

  for (const entry of register.images) {
    if (!built.some((image) => image.name === entry.name)) {
      failures.push(
        `${imageBudgetsFileName} budgets "${entry.name}", but no deploy compose service builds it. ` +
          "A budget for an image nobody builds cannot be measured; remove it or fix the name.",
      );
    }
  }

  const verdicts = [...budgetsByName.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((budget) => judgeImage(budget, readImageSize(budget.name, tag, run)));

  failures.push(...verdictFailures(verdicts));

  return { failures, verdicts };
}

function main(): void {
  const { command, options, help } = parseArguments(process.argv.slice(2));

  if (help || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command !== "check") {
    process.stderr.write(`Unknown command "${command}".\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const repoRoot = options.repoRoot ?? findRepoRoot();
  const tag = options.tag ?? "local";
  const { failures, verdicts } = check(repoRoot, tag, defaultRunner);
  const table = formatVerdictTable(verdicts);

  process.stdout.write(`${table}\n`);

  if (
    process.env["GITHUB_STEP_SUMMARY"] !== undefined &&
    process.env["GITHUB_STEP_SUMMARY"] !== ""
  ) {
    appendFileSync(
      process.env["GITHUB_STEP_SUMMARY"],
      `### Image sizes (tag \`${tag}\`)\n\n${table}\n\n`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write("Every built image is within its stated budget.\n");
}

main();
