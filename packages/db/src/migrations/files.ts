import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reading the migration folder, in one place.
 *
 * The folder is drizzle-kit's output: numbered `.sql` files plus `meta/`, where
 * `_journal.json` records the entries and one snapshot per schema change. The
 * index points at `migrations/` and never at a hand-rolled directory, so the
 * checks in this directory, `pnpm db:migrate` and the testkit harness all read
 * the same files.
 */

export interface SqlMigrationFile {
  readonly name: string;
  readonly path: string;
  readonly sql: string;
}

export interface MigrationJournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

export interface MigrationJournal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly MigrationJournalEntry[];
}

/** `packages/db/migrations`, from source when node strips types and from dist after a build. */
export function migrationsDirectory(): string {
  return fileURLToPath(new URL("../../migrations", import.meta.url));
}

/** Every `.sql` file in the directory, in the order drizzle applies them. */
export function readSqlMigrationFiles(directory: string): SqlMigrationFile[] {
  const status = statSync(directory, { throwIfNoEntry: false });

  if (status === undefined || !status.isDirectory()) {
    return [];
  }

  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((name) => {
      const file = path.join(directory, name);

      return { name, path: file, sql: readFileSync(file, "utf8") };
    });
}

export function journalPath(directory: string): string {
  return path.join(directory, "meta", "_journal.json");
}

export function readMigrationJournal(directory: string): MigrationJournal {
  const raw = readFileSync(journalPath(directory), "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) {
    throw new Error(`${journalPath(directory)} is not a drizzle migration journal.`);
  }

  const entries = (parsed as { entries: unknown }).entries;

  if (!Array.isArray(entries)) {
    throw new Error(`${journalPath(directory)} has a non-array "entries".`);
  }

  return {
    version: String((parsed as { version?: unknown }).version ?? ""),
    dialect: String((parsed as { dialect?: unknown }).dialect ?? ""),
    entries: entries.map((entry: unknown, position: number) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`${journalPath(directory)} entry ${position} is not an object.`);
      }

      const record = entry as Record<string, unknown>;

      return {
        idx: Number(record["idx"] ?? position),
        tag: String(record["tag"] ?? ""),
        when: Number(record["when"] ?? 0),
      };
    }),
  };
}

/**
 * The journal and the `.sql` files must describe the same migration set, or
 * something was renamed, deleted or copied without its journal entry. The two
 * maps are compared in both directions, so a stray file is as loud as a missing
 * one — drizzle's migrator would ignore the former and fail on the latter.
 */
export function migrationSetIssues(
  files: readonly SqlMigrationFile[],
  journal: MigrationJournal,
): string[] {
  const issues: string[] = [];
  const tags = new Set(journal.entries.map((entry) => entry.tag));
  const stems = new Set(files.map((file) => file.name.replace(/\.sql$/, "")));

  for (const entry of journal.entries) {
    if (!stems.has(entry.tag)) {
      issues.push(
        `${journalPath(".")} records ${entry.tag}, but migrations/${entry.tag}.sql does not exist.`,
      );
    }
  }

  for (const file of files) {
    const stem = file.name.replace(/\.sql$/, "");

    if (!tags.has(stem)) {
      issues.push(
        `migrations/${file.name} has no entry in meta/_journal.json; drizzle would never apply it.`,
      );
    }
  }

  journal.entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      issues.push(
        `meta/_journal.json entry ${position} has idx ${entry.idx}; the journal is out of order or has a hole.`,
      );
    }
  });

  if (tags.size !== journal.entries.length) {
    issues.push("meta/_journal.json has duplicate tags; each migration appears once.");
  }

  return issues;
}
