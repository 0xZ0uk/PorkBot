import { describe, expect, it } from "vitest";
import {
  classifyMigrationSql,
  destructiveMigrationIssues,
  isLabelledDestructive,
  stripSqlComments,
} from "./destructive.ts";
import type { SqlMigrationFile } from "./files.ts";
import {
  migrationSetIssues,
  migrationsDirectory,
  readMigrationJournal,
  readSqlMigrationFiles,
} from "./files.ts";

function migration(name: string, sql: string): SqlMigrationFile {
  return { name, path: `/migrations/${name}`, sql };
}

describe("classifying migration SQL", () => {
  it("finds destructive statements", () => {
    const classification = classifyMigrationSql('alter table "bot" drop column "legacy_note";');

    expect(classification.destructive).toContain("DROP COLUMN");
    expect(classification.additive).toEqual([]);
  });

  it("finds every kind of destructive statement the rule names", () => {
    const sql = [
      "drop table if exists old_bots;",
      "drop schema scratch cascade;",
      "drop type old_status;",
      "truncate table events;",
      "delete from messages where id = 'x';",
      'alter table "thread" alter column "title" set data type varchar(120);',
    ].join("\n");

    expect(classifyMigrationSql(sql).destructive).toEqual([
      "DROP TABLE",
      "DROP SCHEMA",
      "DROP TYPE",
      "TRUNCATE",
      "DELETE FROM",
      "ALTER COLUMN ... SET DATA TYPE",
    ]);
  });

  it("finds additive statements", () => {
    const sql = [
      'create table "bot" ("id" uuid primary key);',
      'create unique index "bot_space_idx" on "bot" ("space_id");',
      'alter table "bot" add column "name" text not null;',
      'alter table "bot" add constraint "bot_space_fk" foreign key ("space_id") references "space" ("id");',
    ].join("\n");

    expect(classifyMigrationSql(sql).additive).toEqual([
      "CREATE TABLE",
      "ADD COLUMN",
      "CREATE INDEX",
      "ADD CONSTRAINT",
    ]);
    expect(classifyMigrationSql(sql).destructive).toEqual([]);
  });

  it("does not classify a rename or an index drop as destructive", () => {
    const sql = [
      'alter table "bot" rename column "old_name" to "name";',
      'drop index "bot_name_idx";',
      'alter table "bot" drop constraint "bot_space_fk";',
    ].join("\n");

    expect(classifyMigrationSql(sql).destructive).toEqual([]);
  });

  it("ignores statements a comment only mentions", () => {
    const sql = [
      "-- this migration does not drop table anything",
      "/* and it certainly does not TRUNCATE either */",
      'create table "bot" ("id" uuid primary key);',
    ].join("\n");

    expect(classifyMigrationSql(sql).destructive).toEqual([]);
    expect(stripSqlComments(sql)).not.toContain("drop table");
  });
});

describe("the destructive-migration label", () => {
  it("is present only when the file name carries it as a word", () => {
    expect(isLabelledDestructive("0002_destructive_drop_legacy_note.sql")).toBe(true);
    expect(isLabelledDestructive("0002_destructive-drop-legacy-note.sql")).toBe(true);
    expect(isLabelledDestructive("0002_nondestructive_addition.sql")).toBe(false);
    expect(isLabelledDestructive("0002_add_note.sql")).toBe(false);
  });

  it("fails a destructive file that is not labelled", () => {
    const issues = destructiveMigrationIssues([
      migration("0002_drop_legacy_note.sql", 'alter table "bot" drop column "legacy_note";'),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("is not labelled destructive");
  });

  it("fails a file that mixes destructive and additive statements", () => {
    const issues = destructiveMigrationIssues([
      migration(
        "0002_destructive_drop_legacy_note.sql",
        // prettier-ignore
        'alter table "bot" drop column "legacy_note";\ncreate index "bot_name_idx" on "bot" ("name");',
      ),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("mixes destructive");
  });

  it("accepts a labelled destructive file", () => {
    expect(
      destructiveMigrationIssues([
        migration(
          "0002_destructive_drop_legacy_note.sql",
          'alter table "bot" drop column "legacy_note";',
        ),
      ]),
    ).toEqual([]);
  });

  it("accepts the committed migration set", () => {
    const directory = migrationsDirectory();
    const files = readSqlMigrationFiles(directory);

    expect(destructiveMigrationIssues(files)).toEqual([]);
  });
});

describe("the committed migration set", () => {
  it("is described by its journal in both directions", () => {
    const directory = migrationsDirectory();
    const files = readSqlMigrationFiles(directory);
    const journal = readMigrationJournal(directory);

    expect(migrationSetIssues(files, journal)).toEqual([]);
  });

  it("has a baseline as its first entry", () => {
    const journal = readMigrationJournal(migrationsDirectory());

    expect(journal.dialect).toBe("postgresql");
    expect(journal.entries[0]?.tag).toBe("0000_baseline");
  });
});
