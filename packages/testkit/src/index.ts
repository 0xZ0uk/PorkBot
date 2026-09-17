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
