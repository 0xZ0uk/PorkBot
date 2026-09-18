import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DependencyRegister } from "./register.ts";

/**
 * Container image references, extracted from the files a build actually reads:
 * `FROM` lines in Dockerfiles, `image:` lines in Compose files, and
 * `docker pull` commands in workflows. Every one of them must name a digest
 * that is registered in `dependencies.json`, so a new image cannot enter the
 * build without a deliberate, reviewable pin.
 *
 * The scan is deliberately literal. It does not resolve variables or include
 * files; a `FROM ${BASE}` is reported as an unverifiable reference rather than
 * quietly ignored, because a check that skips what it cannot parse is a check
 * that can be defeated by writing `${BASE}`.
 */

export interface ImageReference {
  /** Repository-relative path and line, e.g. `Dockerfile:3`. */
  readonly source: string;
  readonly reference: string;
}

export interface ImageDiscovery {
  readonly references: readonly ImageReference[];
  readonly errors: readonly string[];
}

const digestSuffix = /@sha256:[a-f0-9]{64}$/i;
const latestTag = /:latest@sha256:/i;

const ignoredDirectories = new Set([
  ".git",
  ".opencode",
  ".turbo",
  ".testkit",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

function unquote(value: string): string {
  const trimmed = value
    .trim()
    .replace(/\s+#.*$/, "")
    .trim();
  const match = /^(['"])(.*)\1$/.exec(trimmed);

  return match === null ? trimmed : (match[2] ?? "");
}

export function dockerfileImageReferences(text: string): { line: number; reference: string }[] {
  const references: { line: number; reference: string }[] = [];
  const stages = new Set<string>();

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      return;
    }

    const match = /^FROM\s+(?:--[\w-]+(?:=\S+)?\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);

    if (match === null) {
      return;
    }

    const reference = match[1] ?? "";
    const stage = match[2]?.toLowerCase();

    if (reference.toLowerCase() === "scratch") {
      return;
    }

    if (stages.has(reference.toLowerCase())) {
      if (stage !== undefined) {
        stages.add(stage);
      }

      return;
    }

    references.push({ line: index + 1, reference });

    if (stage !== undefined) {
      stages.add(stage);
    }
  });

  return references;
}

export function composeImageReferences(text: string): { line: number; reference: string }[] {
  const references: { line: number; reference: string }[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const match = /^\s*image:\s*(.+)$/.exec(rawLine);

    if (match !== null) {
      references.push({ line: index + 1, reference: unquote(match[1] ?? "") });
    }
  });

  return references;
}

export function workflowImageReferences(text: string): { line: number; reference: string }[] {
  const references: { line: number; reference: string }[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const match = /\bdocker\s+pull\s+(\S+)/.exec(rawLine);

    if (match !== null) {
      references.push({ line: index + 1, reference: unquote(match[1] ?? "") });
    }
  });

  return references;
}

function isDockerfile(fileName: string): boolean {
  return /^Dockerfile(?:\..+)?$/i.test(fileName);
}

function isComposeFile(fileName: string): boolean {
  return /^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/i.test(fileName);
}

function scanDirectory(directory: string, repoRoot: string): ImageDiscovery {
  const references: ImageReference[] = [];
  const errors: string[] = [];
  const relativeDirectory = path.relative(repoRoot, directory);

  // A Dockerfile is a Dockerfile wherever it lives; walk the tree rather than
  // guessing the directories a later slice will put them in.
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const absolute = path.join(directory, entry.name);
    const relative = path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      const nested = scanDirectory(absolute, repoRoot);
      references.push(...nested.references);
      errors.push(...nested.errors);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const isWorkflow =
      relative.startsWith(path.join(".github", "workflows")) && /\.ya?ml$/i.test(entry.name);

    if (!isDockerfile(entry.name) && !isComposeFile(entry.name) && !isWorkflow) {
      continue;
    }

    let text: string;

    try {
      text = readFileSync(absolute, "utf8");
    } catch (error) {
      errors.push(`${relative} could not be read: ${(error as Error).message}`);
      continue;
    }

    const found = isDockerfile(entry.name)
      ? dockerfileImageReferences(text)
      : isComposeFile(entry.name)
        ? composeImageReferences(text)
        : workflowImageReferences(text);

    references.push(
      ...found.map(({ line, reference }) => ({ source: `${relative}:${line}`, reference })),
    );
  }

  return { references, errors };
}

export function discoverImageReferences(repoRoot: string): ImageDiscovery {
  return scanDirectory(repoRoot, repoRoot);
}

/**
 * Every reference must be digest-pinned and identical to a registered image.
 * `scratch` and earlier stages are not references and never reach this check.
 */
export function validateImageReferences(
  register: DependencyRegister,
  references: readonly ImageReference[],
): string[] {
  const errors: string[] = [];
  const registered = new Set(register.images.map((image) => image.reference));

  for (const { source, reference } of references) {
    if (!digestSuffix.test(reference)) {
      errors.push(
        `${source}: image "${reference}" is not pinned by digest. Use the registered ` +
          "reference from dependencies.json, e.g. postgres:18@sha256:<64 hex>.",
      );
      continue;
    }

    if (latestTag.test(reference)) {
      errors.push(
        `${source}: image "${reference}" uses the latest tag. Pin the version tag the digest ` +
          "was published under, so the reference reads as what it runs.",
      );
      continue;
    }

    if (!registered.has(reference)) {
      errors.push(
        `${source}: image "${reference}" is not in dependencies.json. Register the reference ` +
          "with the reason it is trusted, so the digest is a decision and not a copy-paste.",
      );
    }
  }

  return errors;
}
