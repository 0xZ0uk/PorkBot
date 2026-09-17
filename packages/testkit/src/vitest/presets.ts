import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";
import type { InlineConfig } from "vitest/node";
import { findRepoRoot } from "../paths.ts";
import {
  entriesFor,
  ledgerFilePath,
  quarantinePattern,
  readLedger,
  validateLedger,
} from "../quarantine/ledger.ts";
import type { Tier } from "../quarantine/ledger.ts";
import { todayIso } from "./flake-reporter.ts";

/**
 * The three test tiers, defined once. A package's vitest config is one call to
 * one of these, so "unit tests never retry" is a property of the tier rather
 * than a promise somebody remembers to keep in twelve config files.
 *
 * Two things are intentionally not configurable per package:
 *
 *   - the retry count. E2E reruns a transient failure twice because a process,
 *     a port and a socket can genuinely race; unit and integration tests are
 *     deterministic in-process code and a retry there hides a real bug.
 *   - the timeouts, and `allowOnly: false`. A test that hangs must fail on a
 *     clock instead of blocking the tier until the job timeout, and a stray
 *     `.only` must fail rather than quietly reduce the suite to one test.
 */

export const e2eRetryCount = 2;

export const tierTimeouts = {
  unit: { testTimeout: 10_000, hookTimeout: 10_000, teardownTimeout: 10_000 },
  integration: { testTimeout: 30_000, hookTimeout: 30_000, teardownTimeout: 20_000 },
  e2e: { testTimeout: 30_000, hookTimeout: 30_000, teardownTimeout: 20_000 },
} as const satisfies Record<Tier, Record<string, number>>;

export const tierRetryCounts = {
  unit: 0,
  integration: 0,
  e2e: e2eRetryCount,
} as const satisfies Record<Tier, number>;

const sharedExcludes = ["**/node_modules/**", "**/dist/**"] as const;

/**
 * Specs that belong to another tier never run in this one. The integration tier
 * is `undefined`: its suites are chosen by `include`, so it keeps vitest's
 * defaults rather than ruling anything out. The e2e tier must not exclude
 * `test/e2e/**` — that is what it runs.
 */
export const tierExcludes: Record<Tier, readonly string[] | undefined> = {
  unit: [...sharedExcludes, "**/*.integration.test.ts", "**/*.e2e.test.ts", "**/test/e2e/**"],
  integration: undefined,
  e2e: [...sharedExcludes, "**/*.integration.test.ts"],
};

export interface TierOptions {
  /** The package directory the config lives in. Defaults to the working directory. */
  readonly packageRoot?: string;
  /** The repository root. Defaults to the first directory holding `pnpm-workspace.yaml`. */
  readonly repoRoot?: string;
  /** Override the ledger path. Only tests do this. */
  readonly ledgerFile?: string;
  /**
   * Shortens this tier's timeouts. Fixtures use it so proving "a hanging test
   * fails rather than blocks" costs a second instead of half a minute; the guard
   * test asserts no shipped package config passes it, so the tier policy stays
   * the policy.
   */
  readonly timeouts?: Partial<Record<"testTimeout" | "hookTimeout" | "teardownTimeout", number>>;
  readonly include?: readonly string[];
  /** Replaces the tier's default exclude list outright. */
  readonly exclude?: readonly string[];
  /** Appended to the tier's default exclude list. */
  readonly additionalExclude?: readonly string[];
  readonly coverageInclude?: readonly string[];
  readonly coverageExclude?: readonly string[];
  readonly coverageThresholds?: Record<string, number>;
}

const flakeReporterPath = fileURLToPath(new URL("./flake-reporter.js", import.meta.url));

function coverageOptions(options: TierOptions): NonNullable<InlineConfig["coverage"]> {
  return {
    provider: "v8",
    reporter: ["text", "json-summary", "lcov"],
    include: [...(options.coverageInclude ?? ["src/**"])],
    exclude: [...(options.coverageExclude ?? ["src/**/*.test.ts", "src/**/*.test.tsx"])],
    ...(options.coverageThresholds === undefined ? {} : { thresholds: options.coverageThresholds }),
  };
}

function tierConfig(tier: Tier, options: TierOptions): ViteUserConfig {
  const packageRoot = path.resolve(options.packageRoot ?? process.cwd());
  const repoRoot = options.repoRoot ?? findRepoRoot(packageRoot);
  const ledgerFile = options.ledgerFile ?? ledgerFilePath(repoRoot);
  const { ledger, errors } = readLedger(ledgerFile);
  const problems =
    errors.length > 0 ? [...errors] : validateLedger(ledger, { repoRoot, today: todayIso() });

  // A broken ledger stops the tier before a single test runs. If this threw
  // after the tests, a stale entry would look like a test failure; if it did not
  // throw at all, an expired entry would be a silently skipped test, which is
  // the exact thing the ledger exists to prevent.
  if (problems.length > 0) {
    throw new Error(
      `${ledgerFile} is not a usable quarantine ledger:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\n\nRun `pnpm quarantine:check` for the same list with the surrounding context.",
    );
  }

  const quarantined = entriesFor(ledger, { tier, repoRoot, packageRoot });
  const pattern = quarantinePattern(quarantined);
  const include = options.include ?? (tier === "integration" ? [] : undefined);
  const defaults = tierExcludes[tier];
  const exclude =
    options.exclude ??
    (defaults === undefined ? undefined : [...defaults, ...(options.additionalExclude ?? [])]);

  return {
    test: {
      ...tierTimeouts[tier],
      ...options.timeouts,
      retry: tierRetryCounts[tier],
      allowOnly: false,
      reporters: [
        ["default"],
        [
          flakeReporterPath,
          { tier, packageRoot, repoRoot, ledgerFile } satisfies Record<string, unknown>,
        ],
      ],
      ...(pattern === undefined ? {} : { testNamePattern: pattern }),
      ...(include === undefined ? {} : { include: [...include] }),
      ...(exclude === undefined ? {} : { exclude: [...exclude] }),
      ...(tier === "unit" ? { coverage: coverageOptions(options) } : {}),
    },
  };
}

/** Unit tests: no retries, coverage on, integration specs excluded. */
export function unit(options: TierOptions = {}): ViteUserConfig {
  return tierConfig("unit", options);
}

/** Tests that need a real service. Never retried, no coverage, no caching. */
export function integration(options: TierOptions = {}): ViteUserConfig {
  return tierConfig("integration", options);
}

/** Whole-process tests. The only tier allowed to retry, and it is counted. */
export function e2e(options: TierOptions = {}): ViteUserConfig {
  return tierConfig("e2e", options);
}

export { defineConfig };
