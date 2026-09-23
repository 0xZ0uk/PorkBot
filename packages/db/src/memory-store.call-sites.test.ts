import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that one module owns memory reads and writes is only a rule if a
 * test walks the call sites. This suite reads the shipped TypeScript in the
 * `src` trees under `apps` and `packages` — tests are excluded, because a spec
 * may name a table to prove something about it — and fails when the memory
 * tables appear anywhere but their schema definition and the store that owns
 * them.
 *
 * Both shapes are scanned: the SQL table names and the Drizzle table handles,
 * so a query written against `memoryDocument` is caught the same as one written
 * against `memory_document`. The scan is textual, so the self-check proves the
 * patterns fire on the shapes they must catch and leave the domain types
 * (`MemoryDocument` from `@porkbot/core`) and prose alone.
 *
 * A scanned tree that is empty would make the rule vacuous, so the suite also
 * asserts the tree it reads and that the two allowed files actually name the
 * tables: the invariant and the evidence that it binds.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The schema definition and the one store; nothing else may name the rows. */
const allowedFiles = new Set([
  "packages/db/src/schema/memory.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/src/memory-store.ts",
]);

const tablePatterns = [
  { pattern: /\bmemory_document\b/g, note: "the memory_document table" },
  { pattern: /\bmemory_revision\b/g, note: "the memory_revision table" },
  { pattern: /\bmemoryDocument\b/g, note: "the memoryDocument table handle" },
  { pattern: /\bmemoryRevision\b/g, note: "the memoryRevision table handle" },
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
      if (group === "packages" && entry.name === "testkit") {
        continue;
      }

      const sourceDirectory = path.join(repoRoot, group, entry.name, "src");

      if (entry.isDirectory() && existsSync(sourceDirectory)) {
        collectSourceFiles(sourceDirectory, collected);
      }
    }
  }

  return collected.map((file) => path.relative(repoRoot, file).split(path.sep).join("/")).sort();
}

describe("the memory table call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/db/src/memory-store.ts");
    expect(files).toContain("packages/db/src/schema/memory.ts");
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const queries = [
      "select id from memory_document where deleted_at is null",
      "insert into memory_revision (document_id) values ($1)",
      'import { memoryDocument } from "./schema/memory.ts";',
      "await db.select().from(memoryRevision);",
    ];

    for (const sample of queries) {
      expect(tableNotes(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves the domain types and prose alone", () => {
    const clean = [
      "import type { MemoryDocument } from '@porkbot/core';",
      "const document: MemoryDocument = row;",
      "// memory documents and their revisions live in Postgres",
      "const memoryRevisionCount = 0;",
    ];

    for (const sample of clean) {
      expect(tableNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every memory row through the store module", () => {
    const offenders = files
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => tableNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files name the memory tables; read and write them through createMemoryStore",
    ).toEqual([]);
  });

  it("has store and schema files that actually name the rows", () => {
    const storeSource = readFileSync(
      path.join(repoRoot, "packages/db/src/memory-store.ts"),
      "utf8",
    );
    const schemaSource = readFileSync(
      path.join(repoRoot, "packages/db/src/schema/memory.ts"),
      "utf8",
    );

    expect(tableNotes(storeSource)).not.toEqual([]);
    expect(tableNotes(schemaSource)).not.toEqual([]);
  });

  it("keeps the schema barrel a re-export, not a call site", () => {
    const barrel = readFileSync(path.join(repoRoot, "packages/db/src/schema/index.ts"), "utf8");

    expect(barrel).toMatch(/export \{ memoryDocument, memoryRevision \} from "\.\/memory\.ts";/);
    expect(barrel, "the barrel may register tables but may not query them").not.toMatch(
      /\.query\(|insert into|delete from/,
    );
  });
});
