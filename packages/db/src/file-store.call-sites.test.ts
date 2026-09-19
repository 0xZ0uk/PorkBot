import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that one module owns the stored-file rows is only a rule if a test
 * walks the call sites. This suite reads the shipped TypeScript in the `src`
 * trees under `apps` and `packages` — tests are excluded, because a spec may
 * name a table to prove something about it — and fails when
 * `message_attachment` or `run_artifact` appears anywhere but their schema
 * definition and the store that owns them (slice 7.6).
 *
 * Both shapes are scanned, SQL name and Drizzle handle, so a query written
 * against `messageAttachment` or `runArtifact` is caught the same as one
 * written against the table name. The seam above the store is the `FileStore`
 * / `RunFileStore` pair the repositories expose; the artifact recorder in the
 * worker writes bytes through the storage seam and records the row through
 * `repositories.files`, so it does not name a table either. The scan is
 * textual, so the self-check proves the patterns fire on the shapes they must
 * catch and leave the names built on top of the tables (`messageAttachmentColumns`,
 * `runArtifactColumns`) alone.
 *
 * A scanned tree that is empty would make the rule vacuous, so the suite also
 * asserts the tree it reads and that the allowed files actually name the rows:
 * the invariant and the evidence that it binds.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The schema definition and the one store; nothing else may name the rows. */
const allowedFiles = new Set([
  "packages/db/src/schema/files.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/src/file-store.ts",
]);

const tablePatterns = [
  { pattern: /\bmessage_attachment\b/g, note: "the message_attachment table" },
  { pattern: /\bmessageAttachment\b/g, note: "the messageAttachment table handle" },
  { pattern: /\brun_artifact\b/g, note: "the run_artifact table" },
  { pattern: /\brunArtifact\b/g, note: "the runArtifact table handle" },
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

describe("the stored-file table call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/db/src/file-store.ts");
    expect(files).toContain("packages/db/src/schema/files.ts");
  });

  it("catches the table shapes it must catch and nothing else", () => {
    const flagged = [
      "select * from message_attachment",
      "const rows = messageAttachment;",
      "delete from run_artifact where id = $1",
      "const rows = runArtifact;",
    ];

    for (const sample of flagged) {
      expect(tableNotes(sample), `${sample} was not flagged`).not.toEqual([]);
    }

    const clean = [
      "const messageAttachmentId = order.messageAttachmentId;",
      "const runArtifactColumns = 'id, storage_key';",
      "the stored file row names its bytes",
      "const files = repositories.files;",
    ];

    for (const sample of clean) {
      expect(tableNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every stored-file row through the store module", () => {
    const offenders = files
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => tableNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files name a stored-file table; read and write through the FileStore and RunFileStore seams",
    ).toEqual([]);
  });

  it("has store and schema files that actually name the rows", () => {
    const storeSource = readFileSync(path.join(repoRoot, "packages/db/src/file-store.ts"), "utf8");
    const schemaSource = readFileSync(
      path.join(repoRoot, "packages/db/src/schema/files.ts"),
      "utf8",
    );

    expect(tableNotes(storeSource)).not.toEqual([]);
    expect(tableNotes(schemaSource)).not.toEqual([]);
  });

  it("keeps the schema barrel a re-export, not a call site", () => {
    const barrel = readFileSync(path.join(repoRoot, "packages/db/src/schema/index.ts"), "utf8");

    expect(barrel).toMatch(/export \{ messageAttachment, runArtifact \} from "\.\/files\.ts";/);
    expect(barrel, "the barrel may register tables but may not query them").not.toMatch(
      /\.query\(|insert into|delete from/,
    );
  });
});
