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

// The AGENTS.md UI rule is lint-enforced, so it is proven the same way the
// boundary rules are: a fixture that must fail and a fixture that must pass.
describe("UI colour rule", () => {
  // The fixture's hex sits on line 5, its rgb() on line 6 and its oklch() on
  // line 7; which line is flagged is what distinguishes the selectors.
  it.each([
    ["hex", 5],
    ["rgb()", 6],
    ["oklch()", 7],
  ])("rejects a hardcoded %s colour in a UI surface", async (_label, line) => {
    const messages = await lint("ui-hardcoded-color.ts", "@porkbot/ui");
    const matched = messages.some(
      (entry) => entry.ruleId === "no-restricted-syntax" && entry.line === line,
    );

    expect(matched, JSON.stringify(messages, null, 2)).toBe(true);
  });

  it("accepts a UI surface that draws from the tokens", async () => {
    const messages = await lint("clean/ui.ts", "@porkbot/ui");
    expect(messages, JSON.stringify(messages, null, 2)).toEqual([]);
  });

  it("does not apply to @porkbot/tokens, where the colours are defined", async () => {
    const messages = await lint("ui-hardcoded-color.ts", "@porkbot/tokens");
    expect(messages, JSON.stringify(messages, null, 2)).toEqual([]);
  });

  it("governs every registered UI surface", async () => {
    for (const packageName of ["@porkbot/web", "@porkbot/desktop", "@porkbot/www"]) {
      const messages = await lint("ui-hardcoded-color.ts", packageName);
      expect(
        messages.some((entry) => entry.ruleId === "no-restricted-syntax"),
        `${packageName} should reject the hardcoded fixture`,
      ).toBe(true);
    }
  });
});
