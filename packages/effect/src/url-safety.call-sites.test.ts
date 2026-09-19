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
 * The one deliberate exception is the register below: a same-origin transport
 * dials the deployment's own origin — configuration plus a constant path —
 * rather than a user-supplied URL, which is what this rule is about. Each entry
 * carries its reason and must still need its exemption, or the suite fails.
 *
 * A scanned tree that is empty would make the rule vacuous, so the suite also
 * asserts the tree it reads and that at least one shipped call site actually
 * names `safeFetch`: the invariant and the evidence that it binds.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

/** The module that owns egress; the only file allowed to touch a transport. */
const urlSafetyModule = "packages/effect/src/url-safety.ts";

/**
 * The sanctioned same-origin transports: files whose only egress goes to the
 * deployment's own origin, never to a URL from user content. `safeFetch`
 * guards third-party destinations and lives in this package, which these
 * clients' module-map entries do not grant them; the exemption is registered
 * here with its reason rather than left to the scanner's shape heuristics, and
 * the "narrow, needed and same-origin" test below turns a stale entry red.
 */
const sameOriginTransports: ReadonlyMap<string, string> = new Map([
  [
    "apps/web/src/transport.ts",
    "the web shell posts the credential exchange to the deployment's own origin: the origin is configuration and the auth paths are constants, and the console's RPC client dials that same origin through the contract",
  ],
]);

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
 * interface or a type literal: the statement starts with `async`, `readonly` or
 * nothing and the parameter list is followed by a return type. A call that
 * starts its statement ends the parameter list and moves on.
 */
function isFetchDeclaration(source: string, index: number): boolean {
  const prefix = source.slice(source.lastIndexOf("\n", index) + 1, index).trim();

  if (!/^(?:async|readonly)?$/.test(prefix)) {
    return false;
  }

  return /^fetch\s*\([\s\S]*?\)\s*(?::|=>)/.test(source.slice(index, index + 240));
}

/**
 * True for a call through the `WebAccessProvider` seam — `provider.fetch(...)`
 * or `harness.provider.fetch(...)`. Those implementations dial through
 * `safeFetch`, so the seam is a sanctioned egress path; a call on any other
 * receiver (`client.fetch(...)`, `notificationProvider.fetch(...)`) stays a
 * raw transport call, which the self-check below pins.
 */
function isProviderSeamCall(source: string, index: number): boolean {
  const prefix = source.slice(Math.max(0, index - 60), index);

  return /(?:^|\.)provider\s*\.\s*$/.test(prefix);
}

/** The egress shapes in one file, as notes a failure message can name. */
function egressNotes(source: string): string[] {
  const notes: string[] = [];

  for (const { pattern, note } of egressPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (
        note === "a raw fetch call" &&
        (isFetchDeclaration(source, match.index) || isProviderSeamCall(source, match.index))
      ) {
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
      "const response = await notificationProvider.fetch(url);",
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
      "  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {",
      "const page = await options.provider.fetch({ url });",
      "const page = await harness.provider.fetch({ url: harness.pageUrl });",
    ];

    for (const sample of clean) {
      expect(egressNotes(sample), `${sample} was flagged`).toEqual([]);
    }
  });

  it("routes every shipped egress through the module", () => {
    const offenders = files
      .filter((file) => file !== urlSafetyModule)
      .filter((file) => !sameOriginTransports.has(file))
      .filter((file) => egressNotes(readFileSync(path.join(repoRoot, file), "utf8")).length > 0);

    expect(
      offenders,
      "these files fetch or dial directly; route them through @porkbot/effect's safeFetch",
    ).toEqual([]);
  });

  it("keeps every same-origin exemption narrow, needed and same-origin", () => {
    for (const [file, reason] of sameOriginTransports) {
      const source = readFileSync(path.join(repoRoot, file), "utf8");

      expect(
        egressNotes(source).length,
        `${file} no longer fetches directly, so its exemption (${reason}) should be deleted`,
      ).toBeGreaterThan(0);
      expect(source, `${file} must dial the configured origin, not a URL of its own`).toContain(
        'options.origin ?? ""',
      );
      expect(source, `${file} must not carry a host literal`).not.toMatch(/https?:\/\//);
    }
  });

  it("has a shipped call site that names the module", () => {
    const users = files.filter((file) =>
      readFileSync(path.join(repoRoot, file), "utf8").includes("safeFetch"),
    );

    expect(users).toContain("packages/adapters/src/http-mail.ts");
  });

  it("keeps the web-access provider on the module's transport by default", () => {
    const source = readFileSync(
      path.join(repoRoot, "packages/adapters/src/http-web-access.ts"),
      "utf8",
    );

    expect(source).toContain("safeFetch");
    expect(source).toContain("options.fetch ?? safeFetch");
  });

  it("keeps the MCP server provider on the module's transport by default", () => {
    // The provider dials through a `fetchImpl` binding rather than a literal
    // `fetch(`, which the textual scan above cannot tell from a raw client, so
    // the default is pinned here the same way the web-access provider's is.
    const source = readFileSync(
      path.join(repoRoot, "packages/adapters/src/http-mcp-server.ts"),
      "utf8",
    );

    expect(source).toContain("safeFetch");
    expect(source).toContain("options.fetch ?? safeFetch");
  });
});
