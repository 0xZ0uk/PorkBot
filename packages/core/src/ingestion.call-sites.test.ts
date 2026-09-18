import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";
import { INGESTION_PATHS } from "./ingestion.ts";
import type { IngestionPath } from "./ingestion.ts";

/**
 * Untrusted ingestion is only labelled if a test walks the call sites. This
 * suite reads the shipped TypeScript in the `src` trees under `apps` and
 * `packages` — tests are excluded because a fixture is allowed to carry raw
 * hostile text — and fails when a module touches a registered ingestion
 * boundary without sending the content through `labelUntrustedContent` (or
 * rendering it through `untrustedPromptSection`).
 *
 * The register in `INGESTION_PATHS` is the anchor: the rule table here must
 * cover every path it names, or `validateRules` fails, so a new path cannot be
 * added without deciding what its boundary symbols are and which modules are
 * allowed to serve raw content. A path whose consumer has not shipped yet
 * declares no symbols and a reason, and the rule flips to enforced with the
 * slice that lands the consumer; `web_fetch` and `mcp_output` are enforced
 * today.
 *
 * The scan is textual, like the URL-safety call-site test, and the self-checks
 * below prove the pattern fires on an unlabelled consumer, stays quiet on a
 * labelling one, and rejects a register with a missing path.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
// `pi-corpus` holds recorded vendor event fixtures, which are test data that
// happens to ship so the replay suite can read them.
const skippedDirectories = new Set([
  "dist",
  "node_modules",
  "coverage",
  ".turbo",
  ".git",
  "pi-corpus",
]);

interface BoundaryRule {
  /** Symbols that mark a module as touching this path's raw content. */
  readonly symbols: readonly string[];
  /** Shipped modules that may name the symbols without labelling. */
  readonly rawModules: readonly string[];
  /** Why a path has no symbols yet; blank once the consumer ships. */
  readonly note: string;
}

const boundaries: Record<IngestionPath, BoundaryRule> = {
  web_fetch: {
    symbols: ["WebAccessProvider", "WebFetchResult", "WebSearchResult"],
    rawModules: [
      "packages/adapter-kit/src/index.ts",
      "packages/adapter-kit/src/provider-plan.ts",
      "packages/adapter-kit/src/web-access.ts",
      "packages/adapters/src/http-web-access.ts",
      "packages/adapters/src/web-access-conformance.ts",
      "packages/adapters/src/web-access-emulator.ts",
      "packages/core/src/ingestion.ts",
    ],
    note: "",
  },
  file_read: {
    symbols: ["ComputerExecResult"],
    rawModules: [
      "packages/adapter-kit/src/computer.ts",
      "packages/adapter-kit/src/index.ts",
      "packages/adapter-kit/src/provider-plan.ts",
      "packages/adapters/src/computer-conformance.ts",
      "packages/adapters/src/computer-emulator.ts",
      "packages/core/src/ingestion.ts",
    ],
    note: "",
  },
  email: {
    symbols: ["WebhookEvent"],
    // The ingress owns the raw bytes and the handler registry is the seam a
    // consumer plugs into; the register itself names the vocabulary.
    rawModules: ["apps/api/src/webhooks.ts", "packages/core/src/ingestion.ts"],
    note: "",
  },
  mcp_output: {
    symbols: ["parsePiEvent", "PI_EVENT_MAPPING"],
    rawModules: [
      "packages/adapters/src/index.ts",
      "packages/adapters/src/pi-events.ts",
      "packages/adapters/src/pi-run-source.ts",
      "packages/core/src/ingestion.ts",
    ],
    note: "",
  },
  computer_output: {
    symbols: ["ComputerExecResult"],
    rawModules: [
      "packages/adapter-kit/src/computer.ts",
      "packages/adapter-kit/src/index.ts",
      "packages/adapter-kit/src/provider-plan.ts",
      "packages/adapters/src/computer-conformance.ts",
      "packages/adapters/src/computer-emulator.ts",
      "packages/core/src/ingestion.ts",
    ],
    note: "",
  },
};

/** The unmatched boundary symbols in one file, as notes a failure message can name. */
function rawNotes(source: string, symbols: readonly string[]): string[] {
  const notes: string[] = [];

  for (const symbol of symbols) {
    if (new RegExp(`\\b${symbol}\\b`).test(source)) {
      notes.push(`names ${symbol}`);
    }
  }

  return notes;
}

function labelsContent(source: string): boolean {
  return /\blabelUntrustedContent\b|\buntrustedPromptSection\b/.test(source);
}

/**
 * Whether the file labels content for this path. Naming the labeller is not
 * enough on its own: the file must also name the path it is labelling, so a
 * module that touches a boundary but labels something else still fails.
 */
function labelsPath(source: string, path: IngestionPath): boolean {
  return labelsContent(source) && (source.includes(`"${path}"`) || source.includes(`'${path}'`));
}

/** Every rule error, not just the first, so one run reports the whole gap. */
function validateRules(rules: Partial<Record<IngestionPath, BoundaryRule>>): string[] {
  const errors: string[] = [];

  for (const path of INGESTION_PATHS) {
    const rule = rules[path];

    if (rule === undefined) {
      errors.push(`ingestion path "${path}" has no boundary rule in the call-site scan`);
      continue;
    }

    if (rule.symbols.length === 0 && rule.note.trim() === "") {
      errors.push(
        `ingestion path "${path}" declares no boundary symbols and no reason; name the consumer or say why it has none`,
      );
    }

    if (rule.symbols.length > 0 && rule.note.trim() !== "") {
      errors.push(
        `ingestion path "${path}" declares boundary symbols and a "not yet" note; one of the two is stale`,
      );
    }
  }

  return errors;
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

/** The files that touch a raw boundary without labelling; empty is the rule. */
function offenders(files: readonly string[], rules: typeof boundaries): string[] {
  const found: string[] = [];

  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");

    for (const path_ of INGESTION_PATHS) {
      const rule = rules[path_];

      if (rule.rawModules.includes(file) || labelsPath(source, path_)) {
        continue;
      }

      for (const note of rawNotes(source, rule.symbols)) {
        found.push(`${file} ${note} without labelling ${path_}`);
      }
    }
  }

  return found;
}

describe("the untrusted ingestion call sites", () => {
  const files = shippedSourceFiles();

  it("scans the shipped source tree, not an empty directory", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("packages/effect/src/web-tools.ts");
    expect(files).toContain("packages/adapters/src/web-access-emulator.ts");
  });

  it("covers every registered ingestion path, with a reason for a path that has no consumer", () => {
    expect(validateRules(boundaries)).toEqual([]);
  });

  it("proves a missing path rule fails and a stale note is caught", () => {
    const webFetch = boundaries.web_fetch;

    expect(validateRules({ web_fetch: webFetch })).toContain(
      'ingestion path "file_read" has no boundary rule in the call-site scan',
    );
    expect(
      validateRules({
        ...boundaries,
        file_read: { symbols: [], rawModules: [], note: "  " },
      }),
    ).toContain(
      'ingestion path "file_read" declares no boundary symbols and no reason; name the consumer or say why it has none',
    );
    expect(
      validateRules({
        ...boundaries,
        file_read: { symbols: ["SomeFileApi"], rawModules: [], note: "later" },
      }),
    ).toContain(
      'ingestion path "file_read" declares boundary symbols and a "not yet" note; one of the two is stale',
    );
  });

  it("proves the scan catches an unlabelled consumer, a raw module and a labelled consumer apart", () => {
    const unlabelled = "const page: WebFetchResult = await provider.fetch(url);";
    const labelled =
      'const page = labelUntrustedContent({ path: "web_fetch", origin: url, content: body });';
    const labelledElsewhere =
      'const note = labelUntrustedContent({ path: "email", origin: sender, content: text });\n' +
      "const page: WebFetchResult = await provider.fetch(url);";
    const rawModule = "export interface WebAccessProvider { fetch(): Promise<WebFetchResult>; }";

    expect(rawNotes(unlabelled, boundaries.web_fetch.symbols)).not.toEqual([]);
    expect(labelsPath(unlabelled, "web_fetch")).toBe(false);
    expect(labelsPath(labelled, "web_fetch")).toBe(true);
    expect(labelsPath(labelledElsewhere, "web_fetch")).toBe(false);
    expect(rawNotes(rawModule, boundaries.web_fetch.symbols)).not.toEqual([]);
    expect(boundaries.web_fetch.rawModules).toContain("packages/adapter-kit/src/web-access.ts");
  });

  it("proves an unenforced path's reason is required", () => {
    expect(validateRules(boundaries)).toEqual([]);
    expect(
      validateRules({
        ...boundaries,
        file_read: { symbols: [], rawModules: [], note: "" },
      }),
    ).toContain(
      'ingestion path "file_read" declares no boundary symbols and no reason; name the consumer or say why it has none',
    );
  });

  it("sends every raw ingestion touch through the labelling boundary", () => {
    expect(
      offenders(files, boundaries),
      "these files touch an ingestion boundary without labelling; call labelUntrustedContent or register the module as a raw boundary",
    ).toEqual([]);
  });

  it("has shipped evidence for every enforced path", () => {
    for (const path_ of INGESTION_PATHS) {
      const rule = boundaries[path_];

      if (rule.symbols.length === 0) {
        continue;
      }

      const users = files.filter((file) => {
        const source = readFileSync(path.join(repoRoot, file), "utf8");
        return rawNotes(source, rule.symbols).length > 0;
      });

      expect(users, `no shipped module names the ${path_} boundary`).not.toEqual([]);
    }
  });
});
