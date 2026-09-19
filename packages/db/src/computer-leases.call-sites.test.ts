import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that one module owns the computer-lease rows is only a rule if a
 * test walks the call sites. This suite reads the shipped TypeScript in the
 * `src` trees under `apps` and `packages` — tests are excluded, because a spec
 * may name a table to prove something about it — and fails when the computer
 * lease table appears anywhere but its schema definition and the store that
 * owns it (slice 7.4).
 *
 * Both shapes are scanned: the SQL table name and the Drizzle table handle, so
 * a query written against `computerLease` is caught the same as one written
 * against `computer_lease`. The seam above the store is the `ComputerLeaseStore`
 * interface in `@porkbot/effect`, whose callers hold and release through
 * `repositories.computerLeases`; only the store module may write SQL. The scan
 * is textual, so the self-check proves the patterns fire on the shapes they
 * must catch and leave prose and the seam types alone.
 *
 * A scanned tree that is empty would make the rule vacuous, so the suite also
 * asserts the tree it reads and that the allowed files actually name the table:
 * the invariant and the evidence that it binds.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The schema definition and the one store; nothing else may name the rows. */
const allowedFiles = new Set([
  "packages/db/src/schema/computers.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/src/computer-leases.ts",
]);

const tablePatterns = [
  { pattern: /\bcomputer_lease\b/g, note: "the computer_lease table" },
  { pattern: /\bcomputerLease\b/g, note: "the computerLease table handle" },
];

/** The table shapes in one file, as notes a failure message can name. */
function tableNotes(source: string): string[] {
  const notes: string[] = [];

  for (const { pattern, note } of tablePatterns) {
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

describe("the computer-lease table call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/db/src/computer-leases.ts");
    expect(files).toContain("packages/db/src/schema/computers.ts");
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const queries = [
      "select owner from computer_lease where bot_id = $1",
      "delete from computer_lease where expires_at <= now()",
      'import { computerLease } from "./schema/computers.ts";',
      "await db.select().from(computerLease);",
    ];

    for (const sample of queries) {
      expect(tableNotes(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves prose and the seam types alone", () => {
    const clean = [
      "import type { ComputerLeaseStore } from '@porkbot/effect';",
      "await repositories.computerLeases.release(holder);",
      "// a computer lease is held for the duration of one command",
      "const computerLeaseTtlSeconds = 120;",
    ];

    for (const sample of clean) {
      expect(tableNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every computer-lease row through the store module", () => {
    const offenders = files
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => tableNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files name the computer lease table; hold and release through the ComputerLeaseStore seam",
    ).toEqual([]);
  });

  it("has store and schema files that actually name the rows", () => {
    const storeSource = readFileSync(
      path.join(repoRoot, "packages/db/src/computer-leases.ts"),
      "utf8",
    );
    const schemaSource = readFileSync(
      path.join(repoRoot, "packages/db/src/schema/computers.ts"),
      "utf8",
    );

    expect(tableNotes(storeSource)).not.toEqual([]);
    expect(tableNotes(schemaSource)).not.toEqual([]);
  });

  it("keeps the schema barrel a re-export, not a call site", () => {
    const barrel = readFileSync(path.join(repoRoot, "packages/db/src/schema/index.ts"), "utf8");

    expect(barrel).toMatch(/export \{ computerLease \} from "\.\/computers\.ts";/);
    expect(barrel, "the barrel may register tables but may not query them").not.toMatch(
      /\.query\(|insert into|delete from/,
    );
  });
});
