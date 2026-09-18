import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The rule that every user-supplied URL is fetched through the URL-safety
 * module is only a rule if a test walks the call sites. This suite reads the
 * shipped TypeScript in the `src` trees under `apps` and `packages` — tests
 * are excluded because an emulator is allowed to dial loopback — and fails
 * when a raw fetch, a node http client or an http client library appears
 * anywhere but the module itself.
 *
 * The scan is textual, so one shape needs care: an interface or type literal
 * that declares a method named `fetch` (the web-access seam does) is a
 * signature, not egress. The declaration filter below skips exactly that shape,
 * and the self-check proves it still catches a statement-level call.
 *
 * A scanned tree that is empty would make the rule vacuous, so the suite also
 * asserts the tree it reads and that at least one shipped call site actually
 * names `safeFetch`: the invariant and the evidence that it binds.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The module that owns egress; the only file allowed to touch a transport. */
const urlSafetyModule = "packages/effect/src/url-safety.ts";

const fetchCall = /(?<!safe)\bfetch\s*\(/g;

const egressPatterns = [
  { pattern: fetchCall, note: "a raw fetch call" },
  { pattern: /globalThis\s*\.\s*fetch\b/g, note: "the platform fetch" },
  {
    pattern: /\bfrom\s+["'](?:node:https|undici|axios|got|node-fetch|superagent|needle)["']/g,
    note: "an http client import",
  },
  { pattern: /\bhttps?\s*\.\s*(?:request|get)\s*\(/g, note: "a node http client call" },
];

/**
 * True for `fetch(request: WebFetchRequest): Promise<WebFetchResult>` inside an
 * interface or a type literal: the statement starts with `fetch` and the
 * parameter list is followed by a return type. A call that starts its statement
 * ends the parameter list and moves on.
 */
function isFetchDeclaration(source: string, index: number): boolean {
  const prefix = source.slice(source.lastIndexOf("\n", index) + 1, index).trim();

  if (!/^(?:async\s+)?(?:readonly\s+)?$/.test(prefix)) {
    return false;
  }

  return /^fetch\s*\([\s\S]*?\)\s*:/.test(source.slice(index, index + 240));
}

/** The egress shapes in one file, as notes a failure message can name. */
function egressNotes(source: string): string[] {
  const notes: string[] = [];

  for (const { pattern, note } of egressPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (note === "a raw fetch call" && isFetchDeclaration(source, match.index)) {
        continue;
      }

      notes.push(note);
    }
  }

  return notes;
}

function collectSourceFiles(directory: string, collected: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        collectSourceFiles(absolute, collected);
      }

      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      collected.push(absolute);
    }
  }
}

function shippedSourceFiles(): string[] {
  const collected: string[] = [];

  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      const sourceDirectory = path.join(repoRoot, group, entry.name, "src");

      if (entry.isDirectory() && existsSync(sourceDirectory)) {
        collectSourceFiles(sourceDirectory, collected);
      }
    }
  }

  return collected.map((file) => path.relative(repoRoot, file).split(path.sep).join("/")).sort();
}

describe("the URL-safety call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/adapters/src/http-mail.ts");
  });

  it("proves the patterns fire on the shapes they must catch", () => {
    const rawCalls = [
      "const response = await fetch(url);",
      "const response = await globalThis.fetch(url);",
      "const response = await client.fetch(url);",
      "fetch(url);",
      'fetch(url, { method: "POST" });',
      'import { request } from "node:https";',
      "https.request(url);",
      "http.get(url);",
      'import axios from "axios";',
    ];

    for (const sample of rawCalls) {
      expect(egressNotes(sample), `${sample} was not caught`).not.toEqual([]);
    }
  });

  it("leaves interface declarations, the module's own call, and non-calls alone", () => {
    const clean = [
      "await safeFetch(url);",
      "const response = await safeFetch(url, { signal });",
      "fetch(request: WebFetchRequest): Promise<WebFetchResult>;",
      "  fetch(\n    request: WebFetchRequest,\n  ): Promise<WebFetchResult>;",
      "readonly fetch: (request: WebFetchRequest) => Promise<WebFetchResult>;",
    ];

    for (const sample of clean) {
      expect(egressNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every shipped egress through the module", () => {
    const offenders = files
      .filter((file) => file !== urlSafetyModule)
      .filter((file) => egressNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files fetch or dial directly; route them through @porkbot/effect's safeFetch",
    ).toEqual([]);
  });

  it("has a shipped call site that names the module", () => {
    const users = files.filter((file) =>
      readFileSync(path.join(repoRoot, file), "utf8").includes("safeFetch"),
    );

    expect(users).toContain("packages/adapters/src/http-mail.ts");
  });
});
