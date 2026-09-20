import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { requiredDeploymentKeys } from "../deployment/validate.ts";
import { findLinkProblems } from "./links.ts";
import type { MarkdownFile } from "./links.ts";
import {
  checkEnvironmentReference,
  readSchemaDeclarations,
  templateKeys,
  unknownEnvironmentMentions,
} from "./reference.ts";

/**
 * The docs staleness check (slice 12.7), run as its own CI tier:
 *
 *   node packages/testkit/src/docs/cli.ts check
 *   pnpm docs:check
 *
 * Two facts are checked. Every relative link, backticked `docs/...md`
 * reference and heading anchor in the repository's markdown (the root set and
 * docs/) resolves against the real tree. Every `PORKBOT_*`/`TESTKIT_*` name a
 * document mentions is declared in a `.env.schema`, in
 * `deploy/porkbot.env.example`, or in the explicit override register below —
 * and `docs/environment.md` covers every schema and template variable with a
 * required/optional answer and a default.
 *
 * Names that are real but not deployment configuration are registered here
 * rather than left to slip through: the register is part of the check, so a
 * new name fails until someone decides which kind it is.
 */

/** Stack, test and release overrides that have no `.env.schema` of their own. */
export const docOnlyNames: readonly string[] = [
  "PORKBOT_DEPLOY_PROJECT",
  "PORKBOT_DEPLOY_WAIT_SECONDS",
  "PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY",
  "PORKBOT_POSTGRES_PORT",
  "PORKBOT_REVERSE_PROXY_PORT",
  "PORKBOT_STACK_PROJECT",
  "PORKBOT_STACK_WAIT_SECONDS",
  "TESTKIT_DATABASE_URL",
  "TESTKIT_HARNESS_STATE",
  "TESTKIT_POSTGRES_IMAGE",
  // The nightly canary's workflow configuration (slice 12.6): repository
  // variables and Actions secrets, not deployment environment. The canary CLI
  // itself reads the generic supervisor and notification names.
  "PORKBOT_CANARY_BUDGET_USD",
  "PORKBOT_CANARY_USD_PER_MINUTE",
  "PORKBOT_CANARY_OWNER",
  "PORKBOT_CANARY_WEBHOOK_URL",
  "PORKBOT_CANARY_WEBHOOK_KEY",
  "PORKBOT_CANARY_CLOUD_ENDPOINT",
  "PORKBOT_CANARY_CLOUD_IMAGE",
  "PORKBOT_CANARY_CLOUD_TOKEN",
];

/** Names a running sandbox holds that no operator configures. */
export const runtimeNames: readonly string[] = [
  "PORKBOT_PROXY_URL",
  "PORKBOT_PROXY_TOKEN",
  "PORKBOT_WEBHOOK_SECRET_<SOURCE>",
];

/** Family prefixes whose suffix is chosen by an operator or a provider. */
export const runtimePrefixes: readonly string[] = ["PORKBOT_WEBHOOK_SECRET"];

const referenceFile = "docs/environment.md";
const templateFile = "deploy/porkbot.env.example";

/**
 * Every markdown file the repository publishes at the root or under docs/,
 * repo-relative and sorted. The root set includes README.md, SECURITY.md,
 * CONTRIBUTING.md and CODE_OF_CONDUCT.md, so a rotted link in any of them is
 * the same red check.
 */
export function markdownFiles(repoRoot: string): MarkdownFile[] {
  const files: MarkdownFile[] = [];
  const add = (relative: string): void => {
    const absolute = path.join(repoRoot, ...relative.split("/"));

    if (existsSync(absolute) && statSync(absolute).isFile()) {
      files.push({ path: relative, text: readFileSync(absolute, "utf8") });
    }
  };

  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      add(entry.name);
    }
  }

  const walk = (relativeDirectory: string): void => {
    const absolute = path.join(repoRoot, ...relativeDirectory.split("/"));

    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      return;
    }

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relative = `${relativeDirectory}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(relative);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({ path: relative, text: readFileSync(path.join(absolute, entry.name), "utf8") });
      }
    }
  };

  walk("docs");

  files.sort((left, right) => left.path.localeCompare(right.path));

  return files;
}

function stripFamily(name: string): string {
  return name.replace(/<[^>]*>/g, "").replace(/_+$/, "");
}

/** Every problem the docs tier reports; empty means the docs are in sync. */
export function checkDocs(repoRoot: string): string[] {
  const files = markdownFiles(repoRoot);
  const problems = findLinkProblems(repoRoot, files);
  const declarations = readSchemaDeclarations(repoRoot);
  const templateText = readFileSync(path.join(repoRoot, ...templateFile.split("/")), "utf8");
  const keys = templateKeys(templateText);
  const referenceText = readFileSync(path.join(repoRoot, ...referenceFile.split("/")), "utf8");

  problems.push(
    ...checkEnvironmentReference({
      text: referenceText,
      declarations,
      templateKeys: keys,
      docOnlyNames,
      runtimeNames,
      runtimePrefixes,
      requiredDeploymentKeys,
    }),
  );

  const knownNames = new Set<string>([
    ...declarations.map((declaration) => declaration.name),
    ...keys,
    ...docOnlyNames,
    ...runtimeNames.map(stripFamily),
  ]);

  for (const file of files) {
    problems.push(...unknownEnvironmentMentions(file.text, file.path, knownNames, runtimePrefixes));
  }

  return problems;
}
