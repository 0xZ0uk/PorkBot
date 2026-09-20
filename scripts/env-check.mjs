#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The `env` CI tier and `pnpm env:check`: every `.env.schema` in the workspace
 * is loaded with the committed `APP_ENV=ci` fixtures, and every package that
 * owns a schema is audited so code and schema cannot drift.
 *
 * `varlock load` proves the schema parses, its imports resolve and every
 * required item has a value; `varlock audit` proves that a variable the code
 * reads is declared, and that a declared variable the code no longer reads is
 * removed. Both run on the pin from `dependencies.json`, installed in the root
 * `node_modules`, so CI and a developer run the same CLI.
 *
 * The schema list is discovered, not registered: an app or package that adds a
 * `.env.schema` is checked from the next run on, and a schema that disappears
 * fails here rather than silently leaving its variables unvalidated.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const varlock = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "varlock.cmd" : "varlock",
);
/** The `ci` environment loads the committed fixtures, never a local override. */
const environment = { ...process.env, APP_ENV: "ci" };

const failures = [];

if (!existsSync(path.join(repoRoot, ".env.schema"))) {
  failures.push("the root .env.schema is missing");
}

/** Every workspace directory that owns a `.env.schema`, by discovery. */
const schemaPackages = ["apps", "packages"].flatMap((group) => {
  const entries = readdirSync(path.join(repoRoot, group), { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${group}/${entry.name}`)
    .filter((dir) => existsSync(path.join(repoRoot, dir, ".env.schema")));
});

/** Runs the pinned CLI, returning the result with output captured for failures. */
function run(args, cwd) {
  return spawnSync(varlock, args, { cwd, env: environment, encoding: "utf8" });
}

function report(label, result) {
  if (result.error !== undefined) {
    failures.push(`${label}: ${result.error.message}`);
    process.stderr.write(`\nFAIL ${label}\n${result.error.message}\n`);
    return;
  }

  if (result.status !== 0) {
    failures.push(label);
    process.stderr.write(`\nFAIL ${label}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    return;
  }

  process.stdout.write(`ok   ${label}\n`);
}

report("load root", run(["load", "--path", "./"], repoRoot));

for (const packageDir of schemaPackages) {
  report(`load ${packageDir}`, run(["load", "--path", `${packageDir}/`], repoRoot));
  report(`audit ${packageDir}`, run(["audit", "src"], path.join(repoRoot, packageDir)));
}

if (failures.length > 0) {
  process.stderr.write(
    `\n${failures.length} environment check(s) failed. Run the same command locally with ` +
      "`pnpm env:check`, and see docs/architecture/development.md (Environment configuration) for the layout.\n",
  );
  process.exit(1);
}

process.stdout.write("\nEvery schema loads and every audit is in sync.\n");
