import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const configDir = path.join(repoRoot, "packages/typescript-config");

function readConfig(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const base = readConfig(path.join(configDir, "base.json"));
const reactLibrary = readConfig(path.join(configDir, "react-library.json"));

// Every one of these must resolve to the given value in the shared base and may
// never be relaxed by a package config. `false` is the strict value for the last two.
const strictOptionValues = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noPropertyAccessFromIndexSignature: true,
  noUncheckedSideEffectImports: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  erasableSyntaxOnly: true,
};

const sharedConfigs = new Map([
  ["@porkbot/typescript-config/base.json", base],
  ["@porkbot/typescript-config/react-library.json", reactLibrary],
]);

function packageConfigs() {
  const configs = [];

  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      for (const file of ["tsconfig.json", "tsconfig.build.json"]) {
        const absolute = path.join(repoRoot, group, entry.name, file);
        if (existsSync(absolute)) {
          configs.push({ label: `${group}/${entry.name}/${file}`, config: readConfig(absolute) });
        }
      }
    }
  }

  return configs;
}

const projectConfigs = packageConfigs();

describe("shared TypeScript strictness", () => {
  it("turns the strict option set on in the base config", () => {
    expect(base.compilerOptions).toMatchObject(strictOptionValues);
  });

  it("does not relax the strict option set in the derived shared configs", () => {
    for (const [flag, value] of Object.entries(strictOptionValues)) {
      if (flag in reactLibrary.compilerOptions) {
        expect(reactLibrary.compilerOptions[flag], `react-library.json ${flag}`).toBe(value);
      }
    }
  });

  it("makes every package config inherit one of the shared configs", () => {
    expect(projectConfigs.length).toBeGreaterThan(0);

    for (const { label, config } of projectConfigs) {
      expect(
        config.extends === "./tsconfig.json" || sharedConfigs.has(config.extends),
        `${label} extends "${config.extends ?? "(nothing)"}"`,
      ).toBe(true);
    }
  });

  it("never overrides a strict option in a package config", () => {
    for (const { label, config } of projectConfigs) {
      for (const [flag, value] of Object.entries(strictOptionValues)) {
        if (flag in (config.compilerOptions ?? {})) {
          expect(config.compilerOptions[flag], `${label} ${flag}`).toBe(value);
        }
      }
    }
  });
});
