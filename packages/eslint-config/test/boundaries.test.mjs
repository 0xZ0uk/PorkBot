import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../base.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const fixtureDir = path.join(repoRoot, "packages", "eslint-config", "fixtures");

const linters = new Map();

function linterFor(packageName) {
  if (!linters.has(packageName)) {
    linters.set(
      packageName,
      new ESLint({
        cwd: repoRoot,
        overrideConfigFile: true,
        overrideConfig: defineConfig({ package: packageName }),
        ignore: false,
      }),
    );
  }

  return linters.get(packageName);
}

async function lint(fixture, packageName) {
  const filePath = path.join(fixtureDir, fixture);
  const [result] = await linterFor(packageName).lintText(readFileSync(filePath, "utf8"), {
    filePath,
  });

  return result.messages;
}

// Each fixture is a deliberate violation. The test fails if the rule stops
// firing, which is what makes the boundary enforceable rather than configured.
const boundaryViolations = [
  {
    fixture: "core-framework-import.ts",
    package: "@porkbot/core",
    ruleId: "no-restricted-imports",
    message: /"hono" is a web framework or transport library owned by @porkbot\/api/,
  },
  {
    fixture: "core-node-built-in.ts",
    package: "@porkbot/core",
    ruleId: "no-restricted-imports",
    message: /no Node built-ins/,
  },
  {
    fixture: "core-adapter-import.ts",
    package: "@porkbot/core",
    ruleId: "no-restricted-imports",
    message: /outside the "@porkbot\/core" boundary/,
  },
  {
    fixture: "api-vendor-sdk-import.ts",
    package: "@porkbot/api",
    ruleId: "no-restricted-imports",
    message: /"openai" is a provider SDK owned by @porkbot\/adapters/,
  },
  {
    fixture: "api-deep-package-import.ts",
    package: "@porkbot/api",
    ruleId: "no-restricted-imports",
    message: /Deep imports into a workspace package are forbidden/,
  },
  {
    fixture: "api-relative-package-escape.ts",
    package: "@porkbot/api",
    ruleId: "import-x/no-relative-packages",
    message: /Relative import from another package/,
  },
  {
    fixture: "inline-type-import.ts",
    package: "@porkbot/api",
    ruleId: "import-x/consistent-type-specifier-style",
    message: /top-level type-only import/,
  },
  {
    fixture: "value-import-used-as-type.ts",
    package: "@porkbot/api",
    ruleId: "@typescript-eslint/consistent-type-imports",
    message: /only used as types/,
  },
  {
    fixture: "explicit-any.ts",
    package: "@porkbot/api",
    ruleId: "@typescript-eslint/no-explicit-any",
    message: /Unexpected any/,
  },
];

// These fixtures are lint-clean on purpose: they catch a rule that fires on
// legal imports.
const allowedFixtures = [
  { fixture: "clean/core.ts", package: "@porkbot/core" },
  { fixture: "clean/api.ts", package: "@porkbot/api" },
  { fixture: "clean/web.ts", package: "@porkbot/web" },
];

describe("module boundary rules", () => {
  it.each(boundaryViolations)(
    "rejects $fixture linted as $package",
    async ({ fixture, package: packageName, ruleId, message }) => {
      const messages = await lint(fixture, packageName);
      const matched = messages.some(
        (entry) => entry.ruleId === ruleId && message.test(entry.message),
      );

      expect(
        matched,
        `expected ${ruleId} on ${fixture}; got ${JSON.stringify(messages, null, 2)}`,
      ).toBe(true);
    },
  );

  it.each(allowedFixtures)(
    "accepts $fixture linted as $package",
    async ({ fixture, package: packageName }) => {
      const messages = await lint(fixture, packageName);
      expect(messages, JSON.stringify(messages, null, 2)).toEqual([]);
    },
  );

  it("refuses to build a config for a package that is not in the module map", () => {
    expect(() => defineConfig({ package: "@porkbot/unregistered" })).toThrow(
      /Unknown workspace package "@porkbot\/unregistered"/,
    );
  });
});
