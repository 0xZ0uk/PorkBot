import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rule that a router never inspects a raw error is only a rule if a test
 * walks the router files. This suite reads every shipped TypeScript file in
 * this directory — tests excluded — and fails when one catches, narrows or
 * otherwise inspects an error. A router throws its typed error and the gate's
 * error boundary maps it with the one table in `@porkbot/effect` (PRD decision
 * 28, AGENTS.md).
 *
 * The scan is textual, so it checks itself in both directions: the router
 * directory must be non-empty, and a fixture proves each pattern still matches
 * the shape it exists to catch. A pattern that stops matching cannot pass
 * silently.
 */

const routersDir = path.dirname(fileURLToPath(import.meta.url));

const forbiddenPatterns = [
  { pattern: /\bcatch\s*\(/g, note: "a catch clause" },
  { pattern: /\btry\s*\{/g, note: "a try block" },
  { pattern: /\binstanceof\s+[A-Z]/g, note: "an instanceof narrowing" },
  { pattern: /\bCause\s*\./g, note: "an inspection of an Effect cause" },
  { pattern: /\.cause\b/g, note: "a read of an error's cause" },
  { pattern: /\bmapError\b/g, note: "a local error mapping (the gate owns the one table)" },
];

const fixture =
  "try { await work(); } catch (error) { " +
  "if (error instanceof Foo) { return error.cause; } } Cause.die(x); mapError(x);";

function routerFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .sort();
}

describe("the routers never inspect an error", () => {
  it("reads a router directory with shipped files in it", () => {
    expect(routerFiles(routersDir).length).toBeGreaterThan(0);
  });

  it("finds none of the forbidden shapes in any router", () => {
    for (const file of routerFiles(routersDir)) {
      const source = readFileSync(path.join(routersDir, file), "utf8");

      for (const { pattern, note } of forbiddenPatterns) {
        expect(source.match(pattern), `${file} contains ${note}`).toBeNull();
      }
    }
  });

  it("catches every forbidden shape in the fixture", () => {
    for (const { pattern } of forbiddenPatterns) {
      expect(fixture.match(pattern), `pattern ${pattern.source} went stale`).not.toBeNull();
    }
  });
});
