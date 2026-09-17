#!/usr/bin/env node
// Aggregates every package's vitest coverage summary into the CI job summary, so
// the numbers a reviewer needs are on the pull request rather than buried in a
// log. Run by the `unit` tier in .github/workflows/ci.yml.
//
// Output is markdown on stdout; the workflow appends it to $GITHUB_STEP_SUMMARY.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const roots = ["apps", "packages"];

// Packages whose coverage thresholds fail the unit tier. Kept here so the
// summary marks them; the thresholds themselves live in each package's
// vitest.config.ts, which is what actually enforces them.
const gatedByThresholds = new Set(["packages/core", "packages/db"]);

const metrics = ["statements", "branches", "functions", "lines"];

function summaryPaths() {
  const found = [];

  for (const root of roots) {
    const rootDir = path.join(repoRoot, root);

    let entries;
    try {
      entries = readdirSync(rootDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidate = path.join(rootDir, entry, "coverage", "coverage-summary.json");

      try {
        if (statSync(candidate).isFile()) {
          found.push({ package: `${root}/${entry}`, file: candidate });
        }
      } catch {
        // No coverage for this package: it has no instrumentable source, or it
        // does not run the coverage task.
      }
    }
  }

  return found.sort((left, right) => left.package.localeCompare(right.package));
}

function percent(entry, metric) {
  const value = entry?.[metric]?.pct;
  return typeof value === "number" ? `${value}%` : "n/a";
}

const found = summaryPaths();

if (found.length === 0) {
  console.error(
    "No coverage summaries found. `pnpm test:coverage` did not produce any, which means " +
      "the coverage task is not wired up. Looked for <root>/<package>/coverage/coverage-summary.json.",
  );
  process.exit(1);
}

const rows = [];

for (const { package: packageName, file } of found) {
  let summary;
  try {
    summary = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Could not read ${file}: ${error.message}`);
    process.exit(1);
  }

  const total = summary.total;
  const gate = gatedByThresholds.has(packageName) ? "**gated**" : "reported";
  rows.push(
    `| ${packageName} | ${gate} | ${metrics.map((metric) => percent(total, metric)).join(" | ")} |`,
  );
}

console.log("### Coverage");
console.log("");
console.log(`| package | gate | ${metrics.join(" | ")} |`);
console.log(`| --- | --- | ${metrics.map(() => "---").join(" | ")} |`);
console.log(rows.join("\n"));
console.log("");
console.log(
  "`gated` packages fail the unit tier below their threshold; `reported` packages publish " +
    "numbers without blocking. Thresholds live in each package's `vitest.config.ts`.",
);
