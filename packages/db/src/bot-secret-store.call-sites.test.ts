import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that one module owns bot-secret reads and writes is only a rule if a
 * test walks the call sites. This suite reads the shipped TypeScript in the
 * `src` trees under `apps` and `packages` — tests are excluded, because a spec
 * may name a table to prove something about it — and fails when the
 * `bot_secret` rows appear anywhere but their schema definition and the store
 * that owns them.
 *
 * Both shapes are scanned: the SQL table name and the Drizzle table handle, so
 * a query written against `botSecret` is caught the same as one written against
 * `bot_secret`. The scan is textual, so the self-check proves the patterns fire
 * on the shapes they must catch and leave the domain vocabulary ("a bot
 * secret", `BotSecrets`) and prose alone.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The schema definition, the barrel and the one store; nothing else may name the rows. */
const allowedFiles = new Set([
  "packages/db/src/schema/bot-secret.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/src/bot-secret-store.ts",
]);

const tablePatterns = [
  { pattern: /\bbot_secret\b/g, note: "the bot_secret table" },
  { pattern: /\bbotSecret\b/g, note: "the botSecret table handle" },
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

describe("the bot secret table call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/db/src/bot-secret-store.ts");
    expect(files).toContain("packages/db/src/schema/bot-secret.ts");
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const queries = [
      "select id from bot_secret where space_id = $1",
      "insert into bot_secret (space_id, bot_id, name) values ($1, $2, $3)",
      'import { botSecret } from "./schema/bot-secret.ts";',
      "await db.select().from(botSecret);",
    ];

    for (const sample of queries) {
      expect(tableNotes(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves the domain vocabulary and prose alone", () => {
    const clean = [
      "import type { BotSecrets } from '@porkbot/effect';",
      "const botSecrets = createBotSecretStore(actor, database);",
      "// a bot secret is one AES-256-GCM envelope in a row",
      "const botSecretName = 'example_api';",
      "const botSecretary = 0;",
    ];

    for (const sample of clean) {
      expect(tableNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every bot secret row through the store module", () => {
    const offenders = files
      .filter((file) => !allowedFiles.has(file))
      .filter((file) => tableNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files name the bot secret rows; read and write them through createBotSecretStore",
    ).toEqual([]);
  });

  it("has store and schema files that actually name the rows", () => {
    const storeSource = readFileSync(
      path.join(repoRoot, "packages/db/src/bot-secret-store.ts"),
      "utf8",
    );
    const schemaSource = readFileSync(
      path.join(repoRoot, "packages/db/src/schema/bot-secret.ts"),
      "utf8",
    );

    expect(tableNotes(storeSource)).not.toEqual([]);
    expect(tableNotes(schemaSource)).not.toEqual([]);
  });

  it("keeps the schema barrel a re-export, not a call site", () => {
    const barrel = readFileSync(path.join(repoRoot, "packages/db/src/schema/index.ts"), "utf8");

    expect(barrel).toMatch(/export \{ botSecret \} from "\.\/bot-secret\.ts";/);
    expect(barrel, "the barrel may register tables but may not query them").not.toMatch(
      /\.query\(|insert into|delete from/,
    );
  });
});
