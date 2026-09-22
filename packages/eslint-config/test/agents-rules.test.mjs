import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AGENTS.md is only a contract if its rules can be checked. This test is the
 * first check: every rule must say how it is checked, every lint rule a rule
 * cites must exist in this package's config, and every path a rule cites must
 * exist in the repository. A stale citation fails CI the same way a dead lint
 * rule does.
 */

const packageDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const agentsFile = path.join(repoRoot, "AGENTS.md");

const requiredSections = ["module map", "provider neutrality", "secrets", "ui", "pull requests"];

function rulesSection() {
  const text = readFileSync(agentsFile, "utf8");
  const start = text.indexOf("\n## Rules");
  return start === -1 ? "" : text.slice(start);
}

function ruleSections() {
  return rulesSection()
    .split(/\n### /)
    .slice(1)
    .map((chunk) => {
      const [heading = "", ...rest] = chunk.split("\n");
      return { heading: heading.trim(), body: rest.join("\n") };
    });
}

function rulesFrom(body) {
  return body
    .split(/\n(?=- \*\*)/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("- **"));
}

function checkClause(rule) {
  const index = rule.indexOf("Checked by:");
  return index === -1 ? "" : rule.slice(index + "Checked by:".length).trim();
}

function citedPaths(rule) {
  const paths = [];
  const backticked = rule.matchAll(/`([^`]+)`/g);

  for (const [, token = ""] of backticked) {
    const candidate = token.replace(/\([^)]*$/, "").trim();

    if (candidate.startsWith("@") || candidate.includes("*")) {
      continue;
    }

    if (
      !/^(?:apps|packages|scripts|\.github|\.agents)\//.test(candidate) &&
      candidate !== "README.md"
    ) {
      continue;
    }

    if (!/\.(?:ts|tsx|js|mjs|json|md|yml|sh)$/.test(candidate)) {
      continue;
    }

    paths.push(candidate);
  }

  return paths;
}

function configSources() {
  return readdirSync(packageDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(path.join(packageDir, name), "utf8"))
    .join("\n");
}

describe("AGENTS.md rules", () => {
  it("covers the five rule areas the repository agreed on", () => {
    const headings = ruleSections().map(({ heading }) => heading.toLowerCase());

    for (const required of requiredSections) {
      expect(
        headings.some((heading) => heading.includes(required)),
        `AGENTS.md should have a "${required}" section, got ${JSON.stringify(headings)}`,
      ).toBe(true);
    }
  });

  it("gives every rule a non-empty Checked by clause", () => {
    const rules = ruleSections().flatMap(({ heading, body }) =>
      rulesFrom(body).map((rule) => ({ heading, rule })),
    );

    expect(rules.length).toBeGreaterThanOrEqual(5);

    for (const { heading, rule } of rules) {
      const clause = checkClause(rule);
      expect(clause.length, `rule in "${heading}" needs a check:\n${rule}`).toBeGreaterThan(0);
      expect(/\w/.test(clause), `rule in "${heading}" has an empty check:\n${rule}`).toBe(true);
    }
  });

  it("only cites lint rules that exist in the eslint config", () => {
    const sources = configSources();
    const rules = ruleSections().flatMap(({ body }) => rulesFrom(body));
    const cited = new Set();

    for (const rule of rules) {
      for (const [, token = ""] of checkClause(rule).matchAll(/`([^`]+)`/g)) {
        if (
        /^(?:[\w@-]+\/)?[\w-]+$/.test(token) &&
        /no-restricted|consistent-type|shadcn\//.test(token)
      ) {
          cited.add(token);
        }
      }
    }

    expect(cited.size, "AGENTS.md should name at least one lint rule").toBeGreaterThan(0);

    for (const ruleId of cited) {
      expect(sources, `${ruleId} is cited by AGENTS.md but not configured`).toContain(ruleId);
    }
  });

  it("only cites paths that exist", () => {
    const rules = ruleSections().flatMap(({ body }) => rulesFrom(body));
    const cited = rules.flatMap((rule) => citedPaths(rule));

    expect(cited.length).toBeGreaterThan(0);

    for (const candidate of cited) {
      expect(
        existsSync(path.join(repoRoot, candidate)),
        `AGENTS.md cites missing ${candidate}`,
      ).toBe(true);
    }
  });
});
