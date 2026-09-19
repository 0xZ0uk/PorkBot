import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that one module owns model connection reads and writes is only a
 * rule if a test walks the call sites. This suite reads the shipped TypeScript
 * in the `src` trees under `apps` and `packages` — tests are excluded, because
 * a spec may name a table to prove something about it — and fails when the
 * `model_connection` rows appear anywhere but their schema definitions, the
 * bot table's foreign key, and the repository module that owns every read and
 * write.
 *
 * Both shapes are scanned: the SQL table name and the Drizzle table handle, so
 * a query written against `modelConnection` is caught the same as one written
 * against `model_connection`. The scan is textual, so the self-check proves the
 * patterns fire on the shapes they must catch and leave the domain vocabulary
 * ("a model connection", `ModelConnection`) and prose alone.
 *
 * The table name is deliberately a compound: `connection` alone would match
 * ordinary prose in a dozen files, and a rule that fires on comments is a rule
 * nobody keeps.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/**
 * The schema definition, the barrel, the bot table's foreign key (which must
 * name the handle to reference it) and the repository module; nothing else may
 * name the rows.
 */
const allowedFiles = new Set([
  "packages/db/src/schema/model-connections.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/src/schema/bots.ts",
  "packages/db/src/repositories.ts",
]);

const tablePatterns = [
  { pattern: /\bmodel_connection\b/g, note: "the model_connection table" },
  { pattern: /\bmodelConnection\b/g, note: "the modelConnection table handle" },
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

describe("the model connection table call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/db/src/repositories.ts");
    expect(files).toContain("packages/db/src/schema/model-connections.ts");
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const queries = [
      "select id from model_connection where space_id = $1",
      "insert into model_connection (space_id, label) values ($1, $2)",
      'import { modelConnection } from "./schema/model-connections.ts";',
      "await db.select().from(modelConnection);",
    ];

    for (const sample of queries) {
      expect(tableNotes(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves the domain vocabulary and prose alone", () => {
    const clean = [
      "import type { ModelConnection } from '@porkbot/adapter-kit';",
      "const modelConnections = createRepositories(actor, database).modelConnections;",
      "// a model connection is one endpoint row per space",
      "const modelConnectionId = 'connection-1';",
      "const modelConnectionColumns = 'id, label';",
    ];

    for (const sample of clean) {
      expect(tableNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every model connection row through the repository module", () => {
    const offenders = files
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => tableNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files name the model connection rows; read and write them through createRepositories",
    ).toEqual([]);
  });

  it("has repository and schema files that actually name the rows", () => {
    const repositorySource = readFileSync(
      path.join(repoRoot, "packages/db/src/repositories.ts"),
      "utf8",
    );
    const schemaSource = readFileSync(
      path.join(repoRoot, "packages/db/src/schema/model-connections.ts"),
      "utf8",
    );

    expect(tableNotes(repositorySource)).not.toEqual([]);
    expect(tableNotes(schemaSource)).not.toEqual([]);
  });
});
