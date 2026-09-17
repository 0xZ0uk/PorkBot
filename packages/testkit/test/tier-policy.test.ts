import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { ViteUserConfig } from "vitest/config";
import { findRepoRoot } from "../src/paths.ts";
import {
  entriesFor,
  ledgerFilePath,
  quarantinePattern,
  readLedger,
  validateLedger,
} from "../src/quarantine/ledger.ts";
import type { Tier } from "../src/quarantine/ledger.ts";
import { todayIso } from "../src/vitest/flake-reporter.ts";
import {
  e2e,
  integration,
  tierExcludes,
  tierRetryCounts,
  tierTimeouts,
  unit,
} from "../src/vitest/presets.ts";

/**
 * The tier policy is only worth anything if it holds for every package. This
 * file loads each package's real vitest config, asserts the policy it resolves
 * to, and refuses a config that hand-rolls its own numbers. It is the reason the
 * policy can live in one place: drift here is a failing test, not a discovery
 * six months later.
 */

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = findRepoRoot(packageRoot);
const scratch = mkdtempSync(path.join(tmpdir(), "porkbot-tier-policy-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// Internal config packages are leaves in the module map (see
// packages/eslint-config/module-boundaries.js): @porkbot/testkit imports
// @porkbot/eslint-config to lint itself, so an edge back into testkit would be a
// dev-only cycle. Their vitest configs repeat the unit tier's numbers, and the
// assertions below are what keep the repetition honest.
const leafPackages = new Set(["packages/eslint-config", "packages/typescript-config"]);

const configFilePattern = /^vitest.*\.config\.ts$/;

interface PackageConfig {
  readonly packageDir: string;
  readonly packageName: string;
  readonly file: string;
  readonly tier: Tier;
}

function tierFromConfigFile(file: string): Tier {
  const base = path.basename(file);

  if (base === "vitest.config.ts") {
    return "unit";
  }

  if (base === "vitest.integration.config.ts") {
    return "integration";
  }

  if (base === "vitest.e2e.config.ts") {
    return "e2e";
  }

  throw new Error(
    `${file} does not name a tier. Configs are vitest.config.ts (unit), ` +
      "vitest.integration.config.ts or vitest.e2e.config.ts, so the tier is readable from the filename.",
  );
}

function packageManifests(): { dir: string; name: string; scripts: Record<string, string> }[] {
  const manifests = [];

  for (const group of ["apps", "packages"]) {
    for (const dirent of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }

      const dir = path.join(repoRoot, group, dirent.name);
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name: string;
        scripts?: Record<string, string>;
      };

      manifests.push({ dir, name: manifest.name, scripts: manifest.scripts ?? {} });
    }
  }

  return manifests;
}

function discoverConfigs(): PackageConfig[] {
  const configs: PackageConfig[] = [];

  for (const manifest of packageManifests()) {
    for (const file of readdirSync(manifest.dir)) {
      if (configFilePattern.test(file)) {
        const absolute = path.join(manifest.dir, file);

        configs.push({
          packageDir: manifest.dir,
          packageName: manifest.name,
          file: path.relative(repoRoot, absolute),
          tier: tierFromConfigFile(file),
        });
      }
    }
  }

  return configs.sort((left, right) => left.file.localeCompare(right.file));
}

const discovered = discoverConfigs();
const loaded = new Map<string, ViteUserConfig>();

async function loadConfig(config: PackageConfig): Promise<ViteUserConfig> {
  const cached = loaded.get(config.file);

  if (cached !== undefined) {
    return cached;
  }

  // Dynamic, because the point is to load what vitest loads: the real config
  // module, resolved through the real package imports.
  const module = (await import(pathToFileURL(path.join(repoRoot, config.file)).href)) as {
    default: ViteUserConfig;
  };

  loaded.set(config.file, module.default);

  return module.default;
}

const ledger = readLedger(ledgerFilePath(repoRoot));

describe("the tier policy holds for every package", () => {
  it("found the configs it is meant to check", () => {
    expect(discovered.length).toBeGreaterThanOrEqual(14);
  });

  it.each(discovered)("$file: $tier timeouts are finite and are the tier's", async (config) => {
    const test = (await loadConfig(config)).test;

    expect(test?.testTimeout).toBe(tierTimeouts[config.tier].testTimeout);
    expect(test?.hookTimeout).toBe(tierTimeouts[config.tier].hookTimeout);
    expect(test?.teardownTimeout).toBe(tierTimeouts[config.tier].teardownTimeout);
    expect(Number.isFinite(test?.testTimeout)).toBe(true);
    expect(Number.isFinite(test?.hookTimeout)).toBe(true);
    expect(Number.isFinite(test?.teardownTimeout)).toBe(true);
  });

  it.each(discovered)("$file: $tier retry policy", async (config) => {
    const test = (await loadConfig(config)).test;

    expect(test?.retry).toBe(tierRetryCounts[config.tier]);
    expect(test?.allowOnly).toBe(false);
  });

  it("only the e2e tier is allowed to retry", () => {
    expect(tierRetryCounts.integration).toBe(0);
    expect(tierRetryCounts.unit).toBe(0);
    expect(tierRetryCounts.e2e).toBeGreaterThan(0);
  });

  it.each(discovered.filter((config) => config.tier === "unit"))(
    "$file: unit specs exclude the other tiers",
    async (config) => {
      const exclude = (await loadConfig(config)).test?.exclude;

      expect(exclude).toContain("**/*.integration.test.ts");
      expect(exclude).toContain("**/*.e2e.test.ts");
      expect(exclude).toContain("**/node_modules/**");
      expect(exclude).toContain("**/dist/**");
    },
  );

  it.each(discovered.filter((config) => config.tier === "integration"))(
    "$file: integration specs are selected explicitly",
    async (config) => {
      expect((await loadConfig(config)).test?.include).toEqual([
        "test/integration/**/*.integration.test.ts",
      ]);
    },
  );

  it.each(discovered.filter((config) => config.tier === "e2e"))(
    "$file: e2e specs are selected explicitly and never excluded",
    async (config) => {
      const test = (await loadConfig(config)).test;

      expect(test?.include).toEqual(["test/e2e/**/*.test.ts"]);
      expect(test?.exclude).not.toContain("**/test/e2e/**");
    },
  );

  it.each(discovered)("$file: retries are reported, not hidden", async (config) => {
    const reporters = (await loadConfig(config)).test?.reporters ?? [];
    const serialized = JSON.stringify(reporters);
    const isLeaf = leafPackages.has(path.dirname(config.file));

    if (isLeaf) {
      // A leaf config cannot import the presets, so it cannot carry the reporter.
      // It also has retry: 0, so there is nothing to report.
      expect(serialized).not.toContain("flake-reporter.js");
      expect((await loadConfig(config)).test?.retry).toBe(0);
      return;
    }

    expect(serialized).toContain("flake-reporter.js");
    expect(serialized).toContain(`"tier":"${config.tier}"`);
  });

  it.each(discovered)("$file: skips exactly the ledger's entries for it", async (config) => {
    const expected = quarantinePattern(
      entriesFor(ledger.ledger, {
        tier: config.tier,
        repoRoot,
        packageRoot: config.packageDir,
      }),
    );
    const actual = (await loadConfig(config)).test?.testNamePattern;

    expect(actual ?? undefined).toBe(expected);
  });

  it("runs the ledger's own validation cleanly, so the configs above were not loaded from a broken ledger", () => {
    expect(ledger.errors).toEqual([]);
    expect(validateLedger(ledger.ledger, { repoRoot, today: todayIso() })).toEqual([]);
  });
});

describe("packages and their configs", () => {
  it("every package that runs tests has a tier config, and every config belongs to such a package", () => {
    const withConfigs = new Set(discovered.map((config) => config.packageName));

    for (const manifest of packageManifests()) {
      const runsTests = Object.keys(manifest.scripts).some((script) => script.startsWith("test"));

      expect(
        withConfigs.has(manifest.name),
        runsTests
          ? `${manifest.name} runs tests but has no vitest config, so it would run with vitest's defaults and no timeout policy.`
          : `${manifest.name} has a vitest config but no test script.`,
      ).toBe(runsTests);
    }
  });

  it("no shipped config shortens its tier's timeouts", () => {
    for (const config of discovered) {
      expect(
        Object.hasOwn(config, "timeouts"),
        `${config.file} must not pass TierOptions["timeouts"]: that seam exists for fixtures.`,
      ).toBe(false);
    }
  });
});

describe("the presets refuse to run with a ledger that is not usable", () => {
  function writeLedger(name: string, entries: unknown[]): string {
    const file = path.join(scratch, name);

    writeFileSync(file, JSON.stringify({ version: 1, entries }, null, 2));

    return file;
  }

  function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "flake-0001",
      tier: "unit",
      file: "packages/testkit/test/fixtures/flake/quarantine.fixture.ts",
      test: "must be skipped while it is quarantined",
      owner: "@Z0uk",
      reason: "the fixture is a deliberate failure",
      issue: "https://github.com/0xZ0uk/PorkBot/issues/19",
      quarantinedOn: "2026-09-01",
      expires: "2099-01-01",
      ...overrides,
    };
  }

  it("throws on an expired entry, before any test runs", () => {
    const file = writeLedger("expired.json", [entry({ expires: "2026-09-02" })]);

    expect(() => unit({ ledgerFile: file, packageRoot, repoRoot })).toThrow(/quarantine expired/);
  });

  it("throws on an entry for a test that no longer exists", () => {
    const file = writeLedger("stale.json", [entry({ test: "a test that moved" })]);

    expect(() => unit({ ledgerFile: file, packageRoot, repoRoot })).toThrow(/no test titled/);
  });

  it("throws on a missing ledger rather than running with an empty one", () => {
    expect(() =>
      unit({ ledgerFile: path.join(scratch, "absent.json"), packageRoot, repoRoot }),
    ).toThrow(/is missing/);
  });

  it("carries the ledger's entries for this tier and package into the pattern", () => {
    const file = writeLedger("current.json", [
      entry({ expires: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) }),
    ]);
    const config = unit({ ledgerFile: file, packageRoot, repoRoot });

    expect(config.test?.testNamePattern).toBe("^(?!.*(?:must be skipped while it is quarantined))");
  });

  it("leaves the tier untouched when the entry belongs to another package", () => {
    const file = writeLedger("elsewhere.json", [
      entry({
        file: "apps/api/test/e2e/health.e2e.test.ts",
        test: "starts, serves /healthz over HTTP and stops on SIGTERM",
        expires: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      }),
    ]);

    expect(unit({ ledgerFile: file, packageRoot, repoRoot }).test?.testNamePattern).toBeUndefined();
  });
});

describe("the three presets are what they say they are", () => {
  it("e2e is the only one that retries", () => {
    expect(e2e({ packageRoot, repoRoot }).test?.retry).toBeGreaterThan(0);
    expect(unit({ packageRoot, repoRoot }).test?.retry).toBe(0);
    expect(integration({ packageRoot, repoRoot }).test?.retry).toBe(0);
  });

  it("excludes exactly the other tiers' specs, and never its own", () => {
    expect(unit({ packageRoot, repoRoot }).test?.exclude).toEqual([...(tierExcludes.unit ?? [])]);
    expect(
      unit({ packageRoot, repoRoot, additionalExclude: ["**/test/fixtures/**"] }).test?.exclude,
    ).toEqual([...(tierExcludes.unit ?? []), "**/test/fixtures/**"]);
    expect(integration({ packageRoot, repoRoot }).test?.exclude).toBeUndefined();
    // The e2e tier runs test/e2e: excluding it is the bug this test exists for.
    expect(e2e({ packageRoot, repoRoot }).test?.exclude).not.toContain("**/test/e2e/**");
  });

  it("unit carries coverage, integration and e2e do not", () => {
    expect(unit({ packageRoot, repoRoot }).test?.coverage).toBeDefined();
    expect(integration({ packageRoot, repoRoot }).test?.coverage).toBeUndefined();
    expect(e2e({ packageRoot, repoRoot }).test?.coverage).toBeUndefined();
  });
});
