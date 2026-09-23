export const moduleInfo = {
  name: "@porkbot/testkit",
  summary:
    "Test policy (tier presets, timeouts, quarantine ledger, dependency pins, flake reporter) plus emulators, harness CLI and database-per-suite isolation.",
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

// The release pipeline (slice 11.7). The commands live in src/release/cli.ts;
// the signing half is exported here because apps/desktop's release-contract
// suite imports `updateSigningPayload` and fails when the release's canonical
// bytes and the app's verified bytes drift apart. The private key never crosses
// this boundary: callers pass it in, and nothing returns it.
export {
  parseReleaseManifest,
  publicKeyPem,
  signReleaseManifest,
  updateSigningPayload,
  verifyReleaseManifest,
} from "./release/signing.ts";
export type { ReleaseUpdateManifest } from "./release/signing.ts";

// Dependency provenance. The register, the manifests, the lockfile and every
// image reference are checked by `checkRepository`, which the `dependencies`
// CI tier runs before the install; `dependencies.json` is the register itself.
export { checkRepository, lockfileName } from "./dependencies/policy.ts";
export type { RepositoryCheck, WorkspaceManifest } from "./dependencies/policy.ts";
export { dependencyRegisterFileName } from "./dependencies/register.ts";
export type { DependencyRegister, PinnedImage, PinnedPackage } from "./dependencies/register.ts";

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
// A connected session for a suite: structurally the `Queryable` the
// repositories take, with the session role set when a suite must prove what
// production's role can do. The harness owns `pg`, so a package whose shipped
// code may not name the driver — the worker — reaches its fixtures through
// this.
export { connectToSuite, connectionStringForRole } from "./harness/client.ts";
export type { ConnectToSuiteOptions, SuiteClient } from "./harness/client.ts";

// The reverse proxy, booted with the config the deployment ships (slice 12.2).
// A suite starts it on a loopback origin and drives the real origin through it:
// the integration suite in apps/api proves streaming, resume, cookies and the
// one-origin routing against the same deploy/Caddyfile an operator runs, and
// `caddyImage` is the digest the `dependencies` tier pins to.
export { caddyImage } from "./harness/images.ts";
export {
  caddyProbePort,
  spaRootPath,
  hostGatewayAddress,
  proxyConfigPath,
  startCaddyProxy,
} from "./proxy/caddy.ts";
export type { CaddyProxyOptions, RunningCaddyProxy } from "./proxy/caddy.ts";

// Public-launch posture (slice 12.8). The file half asserts what a stranger can
// read in LICENSE, CONTRIBUTING, SECURITY, the conduct file, the issue forms
// and the pull-request template; the history half scans every published ref for
// provider-shaped secrets, personal identities and commit prose that should not
// be public. The GitHub-side switches a file cannot express live in
// scripts/setup-repo-security.sh; the CLI in src/posture/cli.ts runs the audit
// as its own CI tier.
export { checkPostureFiles, POSTURE_FILE_RULES } from "./posture/files.ts";
export { publishedRefs, scanHistory } from "./posture/history.ts";
export type { BlobRecord, CommitRecord, HistoryScan, HistoryStats } from "./posture/history.ts";
export { checkPosture } from "./posture/policy.ts";
export type { PostureReport, PostureStats } from "./posture/policy.ts";
export {
  CONTENT_PERSONAL_DATA_RULES,
  PROSE_PERSONAL_DATA_RULES,
  SECRET_PATTERNS,
} from "./posture/patterns.ts";
export type { PersonalDataRule, SecretPattern } from "./posture/patterns.ts";
export type { PostureFinding } from "./posture/finding.ts";

export { uiHooks, uiHookNames, uiHooksByScreen } from "./ui-contract.ts";
export type { UiHookName, UiHookScreen } from "./ui-contract.ts";
