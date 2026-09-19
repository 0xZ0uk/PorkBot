import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rule that lifecycle code never reads a Docker status or message is only
 * a rule if a test walks the modules. `docker-computer.ts` is the lifecycle
 * that composes the Docker primitives, and the supervisor's modules are the
 * lifecycle that composes the provider; in all of them a failure must remain
 * opaque except for the five shared kinds, translated by `docker-errors.ts`
 * alone. This suite scans those files and fails when a Docker message, the
 * daemon's raw message field, the engine's error class or a raw status
 * comparison appears outside the classifier.
 *
 * `docker-engine.ts` is deliberately not scanned: the transport is where a
 * status is read, and its job is to hand `DockerEngineError` upward without
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

/** The one module allowed to read Docker's words. */
const classifierModule = "packages/adapters/src/docker-errors.ts";

/**
 * The lifecycle modules the rule binds to: the provider itself, and the
 * supervisor modules that compose it (the lifecycle service, the provider
 * configuration and the process root). The supervisor's HTTP server is not
 * listed: it compares its own request error's status, never a Docker one.
 */
const lifecycleModules = [
  "packages/adapters/src/docker-computer.ts",
  "apps/supervisor/src/computer-lifecycle.ts",
  "apps/supervisor/src/computer-provider.ts",
  "apps/supervisor/src/main.ts",
].sort();

/**
 * The scanning patterns and the note a failure can carry. The message pattern
 * is a sample of Docker's vocabulary, not an exhaustive list: any inspection
 * that gets past it still trips the two structural patterns, because reading
 * `daemonMessage` or comparing a status is the shape such an inspection takes.
 */
const dockerReadings = [
  {
    pattern:
      /no such (?:container|image|network|volume)|is not running|toomanyrequests|pull access denied|manifest unknown|authentication required/i,
    note: "a Docker error message",
  },
  { pattern: /\bdaemonMessage\b/, note: "the daemon's raw message field" },
  { pattern: /\bDockerEngineError\b/, note: "the engine's error class" },
  {
    pattern: /(?:\.status|\.statusCode)\s*(?:===|!==|==|!=|>=|<=|>|<)/,
    note: "a raw Docker status comparison",
  },
];

function readings(source: string): string[] {
  return dockerReadings.filter(({ pattern }) => pattern.test(source)).map(({ note }) => note);
}

describe("the Docker failure call sites", () => {
  it("scans the lifecycle modules and the classifier, not an empty list", () => {
    expect(lifecycleModules).toContain("packages/adapters/src/docker-computer.ts");
    expect(lifecycleModules).toContain("apps/supervisor/src/computer-lifecycle.ts");
    expect(existsSync(path.join(repoRoot, "packages/adapters/src/docker-computer.ts"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "apps/supervisor/src/computer-lifecycle.ts"))).toBe(true);
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const dirty = [
      'if (error.message.includes("No such container")) {}',
      "if (error.status === 404) {}",
      "const detail = error.daemonMessage;",
      "if (error instanceof DockerEngineError) {}",
      'throw new Error("toomanyrequests");',
    ];

    for (const sample of dirty) {
      expect(readings(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves classified failures and ordinary code alone", () => {
    const clean = [
      'throw new ComputerProviderError("gone", "the machine is gone");',
      'const classified = classifyDockerFailure(error, "container");',
      "status: report.state",
      "const state = statusOf(computer, inspect);",
    ];

    for (const sample of clean) {
      expect(readings(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("keeps every Docker reading inside the classifier", () => {
    for (const module of lifecycleModules) {
      if (!existsSync(path.join(repoRoot, module))) {
        continue;
      }

      const source = readFileSync(path.join(repoRoot, module), "utf8");

      expect(readings(source), `${module} reads Docker's errors directly`).toEqual([]);
    }
  });

  it("has the lifecycle module translate through the classifier", () => {
    const source = readFileSync(
      path.join(repoRoot, "packages/adapters/src/docker-computer.ts"),
      "utf8",
    );

    expect(source).toContain("classifyDockerFailure");
    expect(source).toContain("catch((error: unknown) => failure(error");
  });

  it("keeps the classifier the only module that reads statuses and messages", () => {
    const source = readFileSync(path.join(repoRoot, classifierModule), "utf8");

    expect(readings(source).length).toBeGreaterThan(0);
    expect(source).toContain("messageRules");
  });
});
