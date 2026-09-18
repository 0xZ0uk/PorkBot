import type { SqlMigrationFile } from "./files.ts";

/**
 * The destructive-change rule, as code a reviewer can read.
 *
 * A generated migration is a schema diff; a destructive one drops data or the
 * shape that holds it, and it must be its own file so it can be reasoned about,
 * applied deliberately and rolled back by deploying the previous image. Those
 * are process guarantees, but the labelling half is checkable: the migration
 * suite fails when a file containing destructive DDL is not named `destructive_*`,
 * and when one file mixes destructive and additive statements instead of
 * splitting them.
 *
 * The classifier is deliberately conservative — only statements that can lose
 * data or remove a table, column, schema, type or database count. Dropping an
 * index or a constraint, renaming a column and changing a default are schema
 * changes without data loss and do not need the label.
 */

export interface MigrationClassification {
  /** Statement kinds that can lose data or remove an object. */
  readonly destructive: readonly string[];
  /** Statement kinds that only add schema. */
  readonly additive: readonly string[];
}

const destructivePatterns: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["DROP TABLE", /\bdrop\s+table\b/i],
  ["DROP SCHEMA", /\bdrop\s+schema\b/i],
  ["DROP DATABASE", /\bdrop\s+database\b/i],
  ["DROP TYPE", /\bdrop\s+type\b/i],
  ["DROP COLUMN", /\bdrop\s+column\b/i],
  ["TRUNCATE", /\btruncate\b/i],
  ["DELETE FROM", /\bdelete\s+from\b/i],
  ["ALTER COLUMN ... SET DATA TYPE", /\balter\s+column\s+\S+\s+(?:set\s+data\s+type|type)\b/i],
];

const additivePatterns: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["CREATE TABLE", /\bcreate\s+table\b/i],
  ["ADD COLUMN", /\badd\s+column\b/i],
  ["CREATE INDEX", /\bcreate\s+(?:unique\s+)?index\b/i],
  ["CREATE TYPE", /\bcreate\s+type\b/i],
  ["CREATE SCHEMA", /\bcreate\s+schema\b/i],
  ["CREATE EXTENSION", /\bcreate\s+extension\b/i],
  ["CREATE VIEW", /\bcreate\s+(?:materialized\s+)?view\b/i],
  ["ADD CONSTRAINT", /\badd\s+constraint\b/i],
];

/**
 * `--` line comments and `/* *\/` block comments are removed first, so prose
 * that mentions a drop does not trip the rule. Statement text inside string
 * literals is not parsed; the patterns above are the ones a migration reviewer
 * would look for, and a false positive is visible in the error message.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export function classifyMigrationSql(sql: string): MigrationClassification {
  const statements = stripSqlComments(sql);

  return {
    destructive: destructivePatterns
      .filter(([, pattern]) => pattern.test(statements))
      .map(([label]) => label),
    additive: additivePatterns
      .filter(([, pattern]) => pattern.test(statements))
      .map(([label]) => label),
  };
}

/** `0001_destructive_drop_legacy_note.sql` carries the label; nothing else does. */
export function isLabelledDestructive(fileName: string): boolean {
  return /(?:^|[^a-z])destructive(?:[^a-z]|$)/i.test(fileName.replace(/\.sql$/, ""));
}

/**
 * Every issue with the committed migration set, in the words a reviewer needs.
 * The caller fails the suite when this returns anything.
 */
export function destructiveMigrationIssues(files: readonly SqlMigrationFile[]): string[] {
  const issues: string[] = [];

  for (const file of files) {
    const { destructive, additive } = classifyMigrationSql(file.sql);

    if (destructive.length === 0) {
      continue;
    }

    if (!isLabelledDestructive(file.name)) {
      issues.push(
        `migrations/${file.name} contains ${destructive.join(", ")} but is not labelled destructive. ` +
          "Generate it with `drizzle-kit generate --name=destructive_<what>` so the file name says so.",
      );
    }

    if (additive.length > 0) {
      issues.push(
        `migrations/${file.name} mixes destructive (${destructive.join(", ")}) and additive ` +
          `(${additive.join(", ")}) statements. Make the additive change, generate and commit it, ` +
          "then make the destructive change in its own generated migration.",
      );
    }
  }

  return issues;
}
