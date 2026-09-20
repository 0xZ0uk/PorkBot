import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that one module owns the backup rows is only a rule if a test walks
 * the call sites. This suite reads the shipped TypeScript in the `src` trees
 * under `apps` and `packages` — tests are excluded, because a spec may name a
 * table to prove something about it — and fails when `backup_run`,
 * `backup_canary` or `backup_alert` appears anywhere but its schema definition
 * and the store that owns it.
 *
 * Both shapes are scanned: the SQL table name and the Drizzle table handle, so
 * a query written against `backupRun` is caught the same as one written
 * against `backup_run`. The scan is textual, so the self-check proves the
 * patterns fire on the shapes they must catch and leave the domain vocabulary
 * (`BackupRunRecord`, `BackupStatus`) and prose alone.
 *
 * A scanned tree that is empty would make the rule vacuous, so the suite also
 * asserts the tree it reads and that the two allowed files actually name the
 * tables: the invariant and the evidence that it binds.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The schema definition and the one store; nothing else may name the rows. */
const allowedFiles = new Set([
  "packages/db/src/schema/backups.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/src/backup-store.ts",
]);

const tablePatterns = [
  { pattern: /\bbackup_run\b/g, note: "the backup_run table" },
  { pattern: /\bbackup_canary\b/g, note: "the backup_canary table" },
  { pattern: /\bbackup_alert\b/g, note: "the backup_alert table" },
  { pattern: /\bbackupRun\b/g, note: "the backupRun table handle" },
  { pattern: /\bbackupCanary\b/g, note: "the backupCanary table handle" },
  { pattern: /\bbackupAlert\b/g, note: "the backupAlert table handle" },
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

describe("the backup ledger call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/db/src/backup-store.ts");
    expect(files).toContain("packages/db/src/schema/backups.ts");
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const queries = [
      "select status from backup_run where status = 'failed'",
      "insert into backup_canary (token) values ($1)",
      "update backup_alert set episode = $2 where kind = $1",
      'import { backupRun } from "./schema/backups.ts";',
      "await db.select().from(backupCanary);",
    ];

    for (const sample of queries) {
      expect(tableNotes(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves the domain vocabulary and prose alone", () => {
    const clean = [
      "import type { BackupRunRecord, BackupStatus } from '@porkbot/db';",
      "const backupRuns = new Map();",
      "const backupRuntime = 0;",
      "// a backup run is settled once; backupAlertKind is the vocabulary",
      "const backupRunning = false;",
    ];

    for (const sample of clean) {
      expect(tableNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every backup row through the store module", () => {
    const offenders = files
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => tableNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files name a backup ledger table; read and write it through the backup store",
    ).toEqual([]);
  });

  it("has store and schema files that actually name the rows", () => {
    const storeSource = readFileSync(
      path.join(repoRoot, "packages/db/src/backup-store.ts"),
      "utf8",
    );
    const schemaSource = readFileSync(
      path.join(repoRoot, "packages/db/src/schema/backups.ts"),
      "utf8",
    );

    expect(tableNotes(storeSource)).not.toEqual([]);
    expect(tableNotes(schemaSource)).not.toEqual([]);
  });

  it("keeps the schema barrel a re-export, not a call site", () => {
    const barrel = readFileSync(path.join(repoRoot, "packages/db/src/schema/index.ts"), "utf8");

    expect(barrel).toMatch(/from "\.\/backups\.ts";/);
    expect(barrel, "the barrel may register tables but may not query them").not.toMatch(
      /\.query\(|insert into|delete from/,
    );
  });
});
