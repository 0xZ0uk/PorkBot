import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rule that lifecycle code never reads a Daytona status or message is only
 * a rule if a test walks the modules. `daytona-computer.ts` is the lifecycle
 * that composes the Daytona primitives, and the supervisor's modules are the
 * lifecycle that composes the provider; in all of them a failure must remain
 * opaque except for the five shared kinds, translated by `daytona-errors.ts`
 * (through the shared decision in `computer-failure.ts`) alone. This suite
 * scans those files and fails when a Daytona message, the service's raw
 * message field, the engine's error class or a raw status comparison appears
 * outside the classifier.
 *
 * `daytona-engine.ts` is deliberately not scanned: the transport is where a
 * status is read, and its job is to hand `DaytonaEngineError` upward without
 * interpreting it.
 */

/** The workspace root, found by walking up rather than importing the harness. */
function findRepoRoot(start: string): string {
  let current = start;

  for (;;) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error(`no workspace root above ${start}`);
    }

    current = parent;
  }
}

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

/** The one module allowed to read Daytona's words. */
const classifierModule = "packages/adapters/src/daytona-errors.ts";

/** The lifecycle modules the rule binds to. */
const lifecycleModules = [
  "packages/adapters/src/daytona-computer.ts",
  "apps/supervisor/src/computer-lifecycle.ts",
  "apps/supervisor/src/computer-provider.ts",
  "apps/supervisor/src/main.ts",
].sort();

/**
 * The scanning patterns and the note a failure can carry. The message pattern
 * is a sample of Daytona's vocabulary, not an exhaustive list: any inspection
 * that gets past it still trips the structural patterns, because reading
 * `providerMessage` or comparing a status is the shape such an inspection
 * takes.
 */
const daytonaReadings = [
  {
    pattern:
      /sandbox not found|is not running|too many requests|invalid api key|rate ?limit exceeded|unauthorized/i,
    note: "a Daytona error message",
  },
  { pattern: /\bproviderMessage\b/, note: "the service's raw message field" },
  { pattern: /\bDaytonaEngineError\b/, note: "the engine's error class" },
  {
    pattern: /(?:\.status|\.statusCode)\s*(?:===|!==|==|!=|>=|<=|>|<)/,
    note: "a raw Daytona status comparison",
  },
];

function readings(source: string): string[] {
  return daytonaReadings.filter(({ pattern }) => pattern.test(source)).map(({ note }) => note);
}

describe("the Daytona failure call sites", () => {
  it("scans the lifecycle modules and the classifier, not an empty list", () => {
    expect(lifecycleModules).toContain("packages/adapters/src/daytona-computer.ts");
    expect(lifecycleModules).toContain("apps/supervisor/src/computer-provider.ts");
    expect(existsSync(path.join(repoRoot, "packages/adapters/src/daytona-computer.ts"))).toBe(true);
    expect(existsSync(path.join(repoRoot, classifierModule))).toBe(true);
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const dirty = [
      'if (error.message.includes("Sandbox not found")) {}',
      "if (error.status === 404) {}",
      "const detail = error.providerMessage;",
      "if (error instanceof DaytonaEngineError) {}",
      'throw new Error("too many requests");',
    ];

    for (const sample of dirty) {
      expect(readings(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves classified failures and ordinary code alone", () => {
    const clean = [
      'throw new ComputerProviderError("gone", "the machine is gone");',
      'const classified = classifyDaytonaFailure(error, "sandbox");',
      "status: report.state",
      "const state = machineOf(sandbox);",
    ];

    for (const sample of clean) {
      expect(readings(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("keeps every Daytona reading inside the classifier", () => {
    for (const module of lifecycleModules) {
      if (!existsSync(path.join(repoRoot, module))) {
        continue;
      }

      const source = readFileSync(path.join(repoRoot, module), "utf8");

      expect(readings(source), `${module} reads Daytona's errors directly`).toEqual([]);
    }
  });

  it("has the lifecycle module translate through the classifier", () => {
    const source = readFileSync(
      path.join(repoRoot, "packages/adapters/src/daytona-computer.ts"),
      "utf8",
    );

    expect(source).toContain("classifyDaytonaFailure");
    expect(source).toContain("catch((error: unknown) => failure(error");
  });

  it("routes the decision through the shared classifier", () => {
    const source = readFileSync(path.join(repoRoot, classifierModule), "utf8");

    expect(readings(source).length).toBeGreaterThan(0);
    expect(source).toContain("messageRules");
    expect(source).toContain("computerFailureKind");
  });
});
