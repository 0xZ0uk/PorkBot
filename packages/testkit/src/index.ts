export const moduleInfo = {
  name: "@porkbot/testkit",
  summary:
    "Test policy (tier presets, timeouts, quarantine ledger, flake reporter) plus emulators, harness CLI and database-per-suite isolation.",
} as const;

// The test tiers, their timeouts, their retry policy and the quarantine ledger
// live here rather than in each package's config, so a tier's rules are one
// reviewable file. Production code must not import this package: the module map
// in packages/eslint-config/module-boundaries.js allows these edges in test
// files only.
export {
  e2e,
  e2eRetryCount,
  integration,
  tierRetryCounts,
  tierTimeouts,
  unit,
} from "./vitest/presets.ts";
export type { TierOptions } from "./vitest/presets.ts";
export {
  FlakeReporter,
  annotationLines,
  collectRetriedTests,
  flakeReportMarkdown,
  todayIso,
} from "./vitest/flake-reporter.ts";
export type {
  FlakeReportInput,
  FlakeReporterOptions,
  RetriedTest,
} from "./vitest/flake-reporter.ts";
export {
  daysBetween,
  entriesFor,
  entryStatuses,
  expiryWarningDays,
  formatEntries,
  isIsoDate,
  isTier,
  ledgerFilePath,
  maxQuarantineDays,
  parseLedgerValue,
  quarantineLedgerFileName,
  quarantinePattern,
  readLedger,
  tiers,
  validateLedger,
} from "./quarantine/ledger.ts";
export type {
  EntryStatus,
  LedgerReadResult,
  LedgerValidationOptions,
  QuarantineEntry,
  QuarantineLedger,
  Tier,
} from "./quarantine/ledger.ts";
export { findRepoRoot, isInside, workspaceMarker } from "./paths.ts";

// Postgres-per-suite isolation. A suite calls `createSuiteDatabase` (or
// `startPostgresHarness` when it needs several databases in one file); the CLI
// in src/harness/cli.ts drives the same API across separate processes. The
// template is migrated with plain SQL files until packages/db grows the Drizzle
// migration stack in slice 2.1. The docker seam and the state file stay
// internal: callers get the harness, not its plumbing.
export {
  PostgresHarness,
  createSuiteDatabase,
  productionPostgresMajor,
  startPostgresHarness,
} from "./harness/postgres.ts";
export type {
  PostgresHarnessOptions,
  SuiteDatabase,
  SuiteDatabaseOptions,
} from "./harness/postgres.ts";
export { applyMigrations, listMigrations } from "./harness/migrations.ts";
export type { MigrationFile, MigrationReport } from "./harness/migrations.ts";
