import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that one module owns run creation is only a rule if a test walks
 * the call sites. This suite reads the shipped TypeScript in the `src` trees
 * under `apps` and `packages` — tests are excluded, because a spec may insert a
 * run to prove something about it — and fails when `insert into run` or
 * `insert into task` appears anywhere but the module that owns both commands.
 *
 * The rule exists because the reference implementation grew a dozen
 * near-duplicate creation sites, each with its own ordering and idempotency
 * (PRD decision 5). A scheduled run and an interactive run must share the
 * insert, the nonce discipline and the initial status; the scheduler is a
 * producer, not a second creator. The scan is textual and the patterns are the
 * statement text, so prose about "run creation" and a local variable named
 * `task` are left alone, and the self-check proves both directions.
 *
 * A scanned tree that is empty would make the rule vacuous, so the suite
 * asserts the tree it reads and that the owning module actually contains both
 * statements: the invariant and the evidence that it binds.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The one module: both run-creation commands, message-triggered and routine-triggered. */
const allowedFiles = new Set(["packages/db/src/run-creation.ts"]);

const statementPatterns = [
  { pattern: /\binsert into run\b/gi, note: "an insert into the run table" },
  { pattern: /\binsert into task\b/gi, note: "an insert into the task table" },
];

function statementNotes(source: string): string[] {
  const notes: string[] = [];

  for (const { pattern, note } of statementPatterns) {
    if (source.match(pattern) !== null) {
      notes.push(note);
    }
  }

  return notes;
}

function collectSourceFiles(directory: string, collected: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        collectSourceFiles(absolute, collected);
      }

      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      collected.push(absolute);
    }
  }
}

function shippedSourceFiles(): string[] {
  const collected: string[] = [];

  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      const sourceDirectory = path.join(repoRoot, group, entry.name, "src");

      if (entry.isDirectory() && existsSync(sourceDirectory)) {
        collectSourceFiles(sourceDirectory, collected);
      }
    }
  }

  return collected.map((file) => path.relative(repoRoot, file).split(path.sep).join("/")).sort();
}

describe("the run-creation call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/db/src/run-creation.ts");
  });

  it("proves the patterns fire on the statements they must catch", () => {
    const samples = [
      "insert into run (space_id) values ($1)",
      '  "insert into task (space_id, prompt, status) "',
      "INSERT INTO run (space_id) values ($1)",
    ];

    for (const sample of samples) {
      expect(statementNotes(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves prose and local names alone", () => {
    const clean = [
      "const task = insertedRow(rows);",
      "// run creation lives in one module, message-triggered and routine-triggered",
      "insert into run_attempt (id) values ($1)",
      "const insertedRun = runRows[0];",
    ];

    for (const sample of clean) {
      expect(statementNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every task and run insert through the run-creation module", () => {
    const offenders = files
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => statementNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files insert a task or a run; add a command to packages/db/src/run-creation.ts " +
        "instead of a second creation site",
    ).toEqual([]);
  });

  it("has an owning module that actually contains both statements", () => {
    const source = readFileSync(path.join(repoRoot, "packages/db/src/run-creation.ts"), "utf8");

    expect(statementNotes(source)).toEqual([
      "an insert into the run table",
      "an insert into the task table",
    ]);
  });
});
