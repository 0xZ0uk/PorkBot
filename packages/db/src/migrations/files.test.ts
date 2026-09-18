import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  journalPath,
  migrationSetIssues,
  migrationsDirectory,
  readMigrationJournal,
  readSqlMigrationFiles,
} from "./files.ts";
import type { MigrationJournal, MigrationJournalEntry, SqlMigrationFile } from "./files.ts";

function withScratch<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), "porkbot-journal-"));

  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function file(name: string): SqlMigrationFile {
  return { name, path: `/migrations/${name}`, sql: "--" };
}

function journal(entries: readonly Partial<MigrationJournalEntry>[]): MigrationJournal {
  return {
    version: "7",
    dialect: "postgresql",
    entries: entries.map((entry, position) => ({
      idx: entry.idx ?? position,
      tag: entry.tag ?? `000${position}_entry`,
      when: entry.when ?? 1_700_000_000_000 + position,
    })),
  };
}

describe("reading the migration folder", () => {
  it("reads .sql files in application order", () =>
    withScratch((directory) => {
      writeFileSync(path.join(directory, "0001_second.sql"), "select 2;");
      writeFileSync(path.join(directory, "0000_first.sql"), "select 1;");
      writeFileSync(path.join(directory, "notes.txt"), "ignore me");

      const files = readSqlMigrationFiles(directory);

      expect(files.map((entry) => entry.name)).toEqual(["0000_first.sql", "0001_second.sql"]);
      expect(files[0]?.sql).toBe("select 1;");
    }));

  it("reads nothing from a directory that does not exist", () =>
    withScratch((directory) => {
      expect(readSqlMigrationFiles(path.join(directory, "missing"))).toEqual([]);
    }));

  it("ships a migrations directory this package owns", () => {
    expect(statSync(migrationsDirectory()).isDirectory()).toBe(true);
    expect(migrationsDirectory().endsWith(path.join("packages", "db", "migrations"))).toBe(true);
  });
});

describe("reading the journal", () => {
  it("fails loudly when there is no journal", () =>
    withScratch((directory) => {
      expect(() => readMigrationJournal(directory)).toThrow(/ENOENT|no such file/);
    }));

  it("rejects a file that is not a journal", () =>
    withScratch((directory) => {
      mkdirSync(path.join(directory, "meta"));
      writeFileSync(journalPath(directory), "{}");
      expect(() => readMigrationJournal(directory)).toThrow(/not a drizzle migration journal/);

      writeFileSync(journalPath(directory), JSON.stringify({ entries: "nope" }));
      expect(() => readMigrationJournal(directory)).toThrow(/non-array/);

      writeFileSync(journalPath(directory), JSON.stringify({ entries: [3] }));
      expect(() => readMigrationJournal(directory)).toThrow(/entry 0 is not an object/);
    }));

  it("fills in defaults for entries that omit optional fields", () =>
    withScratch((directory) => {
      mkdirSync(path.join(directory, "meta"));
      writeFileSync(
        journalPath(directory),
        JSON.stringify({ entries: [{ tag: "0000_baseline" }, {}] }),
      );

      expect(readMigrationJournal(directory).entries).toEqual([
        { idx: 0, tag: "0000_baseline", when: 0 },
        { idx: 1, tag: "", when: 0 },
      ]);
    }));
});

describe("comparing the journal with the files", () => {
  const baseline = file("0000_baseline.sql");

  it("accepts a set where both sides agree", () => {
    expect(migrationSetIssues([baseline], journal([{ idx: 0, tag: "0000_baseline" }]))).toEqual([]);
  });

  it("reports a journal entry with no file", () => {
    const issues = migrationSetIssues([baseline], journal([{ tag: "0000_gone" }]));

    expect(issues.join("\n")).toContain("0000_gone.sql does not exist");
  });

  it("reports a file with no journal entry", () => {
    const issues = migrationSetIssues(
      [baseline, file("0001_stray.sql")],
      journal([{ tag: "0000_baseline" }]),
    );

    expect(issues.join("\n")).toContain("0001_stray.sql has no entry");
  });

  it("reports an index hole", () => {
    const issues = migrationSetIssues(
      [baseline, file("0001_second.sql")],
      journal([
        { idx: 0, tag: "0000_baseline" },
        { idx: 2, tag: "0001_second" },
      ]),
    );

    expect(issues.join("\n")).toContain("entry 1 has idx 2");
  });

  it("reports duplicate tags", () => {
    const issues = migrationSetIssues(
      [baseline],
      journal([
        { idx: 0, tag: "0000_baseline" },
        { idx: 1, tag: "0000_baseline" },
      ]),
    );

    expect(issues.join("\n")).toContain("duplicate tags");
  });
});
