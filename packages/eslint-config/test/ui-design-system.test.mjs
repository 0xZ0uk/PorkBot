import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../base.js";
import { shadcnRuleIds, uiSurfacePackages } from "../ui-design-system.js";

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

function designSystemMessages(messages) {
  return messages.filter((entry) => (entry.ruleId ?? "").startsWith("shadcn/"));
}

// The AGENTS.md (UI) rules are lint-enforced, so each one is proven the way
// the boundary rules are: a fixture that must fail, a fixture that must pass
// and — because a suite asserts on markup — a test file where every rule
// stays silent.
describe("the design-system rules", () => {
  it("rejects a restyled register component and names the variant to use", async () => {
    const messages = designSystemMessages(await lint("ui-restyled.tsx", "@porkbot/web"));
    const restyled = messages.filter((entry) => entry.ruleId === "shadcn/no-restyle");

    expect(restyled.length, JSON.stringify(messages, null, 2)).toBeGreaterThanOrEqual(2);
    const named = restyled.map((entry) => entry.message).join(" ");
    expect(named).toContain("Card");
    expect(named).toContain("Button");
  });

  it("rejects a raw palette colour", async () => {
    const messages = designSystemMessages(await lint("ui-raw-colour.tsx", "@porkbot/web"));
    const raw = messages.find((entry) => entry.ruleId === "shadcn/no-raw-colors");

    expect(raw, JSON.stringify(messages, null, 2)).toBeDefined();
    expect(raw.message).toContain("bg-pink-500");
  });

  it("rejects an off-token arbitrary value", async () => {
    const messages = designSystemMessages(await lint("ui-arbitrary-value.tsx", "@porkbot/web"));
    const arbitrary = messages.find((entry) => entry.ruleId === "shadcn/no-arbitrary-values");

    expect(arbitrary, JSON.stringify(messages, null, 2)).toBeDefined();
    expect(arbitrary.message).toContain("p-[13px]");
  });

  it("rejects an inline style", async () => {
    const messages = designSystemMessages(await lint("ui-inline-style.tsx", "@porkbot/web"));
    const inline = messages.find((entry) => entry.ruleId === "shadcn/no-inline-styles");

    expect(inline, JSON.stringify(messages, null, 2)).toBeDefined();
    expect(inline.message).toContain("color");
  });

  it("rejects a class no build generates", async () => {
    const messages = designSystemMessages(await lint("ui-unknown-class.tsx", "@porkbot/web"));
    const unknown = messages.filter((entry) => entry.ruleId === "shadcn/no-unknown-classes");

    expect(unknown.length, JSON.stringify(messages, null, 2)).toBeGreaterThanOrEqual(2);
    expect(unknown.map((entry) => entry.message).join(" ")).toContain("rounded-huge");
  });

  it("rejects a class name built from a value", async () => {
    const messages = designSystemMessages(await lint("ui-dynamic-class.tsx", "@porkbot/web"));
    const dynamic = messages.find((entry) => entry.ruleId === "shadcn/require-static-classes");

    expect(dynamic, JSON.stringify(messages, null, 2)).toBeDefined();
    expect(dynamic.message).toContain("Button");
  });

  it("accepts a surface composed from the register", async () => {
    const messages = designSystemMessages(await lint("clean/ui-design-system.tsx", "@porkbot/web"));

    expect(messages, JSON.stringify(messages, null, 2)).toEqual([]);
  });

  it("stays silent in a test file, which asserts on markup", async () => {
    const messages = designSystemMessages(await lint("ui-design-system.test.tsx", "@porkbot/web"));

    expect(messages, JSON.stringify(messages, null, 2)).toEqual([]);
  });

  it("governs every registered UI surface and nothing else", async () => {
    expect(uiSurfacePackages).toEqual([
      "@porkbot/ui",
      "@porkbot/web",
      "@porkbot/desktop",
      "@porkbot/www",
    ]);

    for (const packageName of uiSurfacePackages) {
      const messages = designSystemMessages(await lint("ui-raw-colour.tsx", packageName));

      expect(
        messages.some((entry) => entry.ruleId === "shadcn/no-raw-colors"),
        `${packageName} should reject the raw-colour fixture`,
      ).toBe(true);
    }

    // A non-surface package gets none of them: @porkbot/tokens is where the
    // colour literals belong, and a rule that fired there would fail the file
    // the rules exist to protect.
    const outside = designSystemMessages(await lint("ui-raw-colour.tsx", "@porkbot/tokens"));

    expect(outside, JSON.stringify(outside, null, 2)).toEqual([]);
  });

  it("registers every rule AGENTS.md points at", () => {
    expect(shadcnRuleIds).toEqual([
      "shadcn/no-restyle",
      "shadcn/no-raw-colors",
      "shadcn/no-arbitrary-values",
      "shadcn/no-inline-styles",
      "shadcn/no-unknown-classes",
      "shadcn/require-static-classes",
    ]);
  });
});
