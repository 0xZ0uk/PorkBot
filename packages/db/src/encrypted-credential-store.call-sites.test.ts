import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that one module owns encrypted credential reads and writes is only a
 * rule if a test walks the call sites. This suite reads the shipped TypeScript
 * in the `src` trees under `apps` and `packages` — tests are excluded, because a
 * spec may name a table to prove something about it — and fails when the
 * `encrypted_credential` rows appear anywhere but their schema definition and
 * the store that owns them.
 *
 * Both shapes are scanned: the SQL table name and the Drizzle table handle, so
 * a query written against `encryptedCredential` is caught the same as one
 * written against `encrypted_credential`. The scan is textual, so the self-check
 * proves the patterns fire on the shapes they must catch and leave the domain
 * vocabulary ("an encrypted credential", `Credentials`) and prose alone.
 *
 * The table name is deliberately a compound: `credential` alone would match
 * ordinary prose in a dozen files, and a rule that fires on comments is a rule
 * nobody keeps.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The schema definition, the barrel and the one store; nothing else may name the rows. */
const allowedFiles = new Set([
  "packages/db/src/schema/encrypted-credential.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/src/encrypted-credential-store.ts",
]);

const tablePatterns = [
  { pattern: /\bencrypted_credential\b/g, note: "the encrypted_credential table" },
  { pattern: /\bencryptedCredential\b/g, note: "the encryptedCredential table handle" },
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

describe("the encrypted credential table call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/db/src/encrypted-credential-store.ts");
    expect(files).toContain("packages/db/src/schema/encrypted-credential.ts");
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const queries = [
      "select id from encrypted_credential where space_id = $1",
      "insert into encrypted_credential (space_id, name, envelope) values ($1, $2, $3, $4)",
      'import { encryptedCredential } from "./schema/encrypted-credential.ts";',
      "await db.select().from(encryptedCredential);",
    ];

    for (const sample of queries) {
      expect(tableNotes(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves the domain vocabulary and prose alone", () => {
    const clean = [
      "import type { Credentials } from '@porkbot/effect';",
      "const credentials = createRepositories(actor, database);",
      "// an encrypted credential is one AES-256-GCM envelope in a row",
      "const credentialName = 'model-key';",
      "const encryptedCredentialStore = 0;",
    ];

    for (const sample of clean) {
      expect(tableNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every encrypted credential row through the store module", () => {
    const offenders = files
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => tableNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files name the encrypted credential rows; read and write them through createEncryptedCredentialStore",
    ).toEqual([]);
  });

  it("has store and schema files that actually name the rows", () => {
    const storeSource = readFileSync(
      path.join(repoRoot, "packages/db/src/encrypted-credential-store.ts"),
      "utf8",
    );
    const schemaSource = readFileSync(
      path.join(repoRoot, "packages/db/src/schema/encrypted-credential.ts"),
      "utf8",
    );

    expect(tableNotes(storeSource)).not.toEqual([]);
    expect(tableNotes(schemaSource)).not.toEqual([]);
  });

  it("keeps the schema barrel a re-export, not a call site", () => {
    const barrel = readFileSync(path.join(repoRoot, "packages/db/src/schema/index.ts"), "utf8");

    expect(barrel).toMatch(/export \{ encryptedCredential \} from "\.\/encrypted-credential\.ts";/);
    expect(barrel, "the barrel may register tables but may not query them").not.toMatch(
      /\.query\(|insert into|delete from/,
    );
  });
});
