import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../base.js";
import { registerClassPrefix, registeredMarkup } from "../ui-register.js";

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

function registerMessages(messages) {
  return messages.filter(
    (entry) => entry.ruleId === "no-restricted-syntax" && entry.message.includes("AGENTS.md (UI)"),
  );
}

// The register rule from AGENTS.md is lint-enforced, so it is proven the same
// way the boundary and colour rules are: a fixture that must fail and a
// fixture that must pass. The register map is tied to the package's exports so
// a rename on either side fails here rather than in review.
describe("the component register rule", () => {
  it("rejects a hand-rolled button and names the import to use", async () => {
    const messages = registerMessages(await lint("ui-hand-rolled-button.tsx", "@porkbot/web"));
    const button = messages.find((entry) => entry.message.includes("<button>"));

    expect(button, JSON.stringify(messages, null, 2)).toBeDefined();
    expect(button?.message).toContain("Button or IconButton");
  });

  it("rejects a hand-rolled field wrapper and control", async () => {
    const messages = registerMessages(await lint("ui-hand-rolled-field.tsx", "@porkbot/web"));
    const input = messages.find((entry) => entry.message.includes("<input>"));
    const field = messages.find((entry) => entry.message.includes('"field"'));

    expect(input?.message).toContain("Input");
    expect(field?.message).toContain("Field");
  });

  it("rejects the card chrome class", async () => {
    const messages = registerMessages(await lint("ui-hand-rolled-card.tsx", "@porkbot/web"));
    const card = messages.find((entry) => entry.message.includes('"card"'));

    expect(card?.message).toContain("Card");
  });

  it("rejects a surface that writes the register's own class namespace", async () => {
    const messages = registerMessages(await lint("ui-register-namespace.tsx", "@porkbot/web"));
    const namespace = messages.find((entry) =>
      entry.message.includes(`"${registerClassPrefix}" class`),
    );

    expect(namespace, JSON.stringify(messages, null, 2)).toBeDefined();
  });

  it("accepts a screen composed from the register", async () => {
    const messages = await lint("clean/ui-register.tsx", "@porkbot/web");
    expect(messages, JSON.stringify(messages, null, 2)).toEqual([]);
  });

  it("does not govern the register itself", async () => {
    const messages = await lint("ui-hand-rolled-button.tsx", "@porkbot/ui");
    expect(registerMessages(messages)).toEqual([]);
  });

  it("governs every registered surface", async () => {
    for (const packageName of ["@porkbot/desktop", "@porkbot/www"]) {
      const messages = registerMessages(await lint("ui-hand-rolled-button.tsx", packageName));
      expect(messages.length, `${packageName} should reject the fixture`).toBeGreaterThan(0);
    }
  });

  it("is silent in a surface's test files, which may render raw markup", async () => {
    const messages = registerMessages(await lint("ui-hand-rolled-button.tsx", "@porkbot/web"));
    expect(messages.length).toBeGreaterThan(0);

    // The file name is what places a fixture inside or outside the rule; a
    // spec beside a screen is allowed the raw element.
    const [result] = await linterFor("@porkbot/web").lintText(
      readFileSync(path.join(fixtureDir, "ui-hand-rolled-button.tsx"), "utf8"),
      { filePath: path.join(repoRoot, "apps", "web", "src", "screens", "fixture.test.tsx") },
    );
    expect(registerMessages(result.messages)).toEqual([]);
  });

  it("covers the register's own definition", () => {
    const names = registeredMarkup.map((entry) => entry.name);
    expect(names).toContain("button");
    expect(names).toContain("card");
    expect(names).toContain("field");
  });

  it("ties every registered component to an export in @porkbot/ui", () => {
    const source = readFileSync(path.join(repoRoot, "packages", "ui", "src", "index.ts"), "utf8");
    const exported = new Set();

    for (const [, names = ""] of source.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const name of names.split(",")) {
        const trimmed = name.trim().replace(/^type\s+/, "");

        if (trimmed !== "") {
          exported.add(trimmed);
        }
      }
    }

    for (const entry of registeredMarkup) {
      for (const component of entry.components) {
        expect(
          exported.has(component),
          `${entry.name} names ${component}, which @porkbot/ui does not export`,
        ).toBe(true);
      }
    }
  });
});
