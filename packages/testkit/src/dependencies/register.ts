import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The dependency register: `dependencies.json` at the repository root is the
 * one place a version or an image digest is chosen deliberately. Every entry
 * carries the reason it is pinned, because "we pinned it" without a why is a
 * fact nobody can review.
 *
 * The register is not a copy of what is installed — that is the lockfile's job.
 * It is the claim the repository makes about what it is allowed to run, and the
 * policy check fails when the manifests, the lockfile or the harness drift away
 * from it.
 */

export const dependencyRegisterFileName = "dependencies.json";

export interface PinnedPackage {
  /** The npm package name, e.g. `@earendil-works/pi-agent-core`. */
  readonly name: string;
  /** An exact version: no ranges, no tags, no git refs. */
  readonly version: string;
  /** Why this package is pinned, in words a reviewer can act on. */
  readonly reason: string;
}

export interface PinnedImage {
  /** A short label used in error messages, e.g. `postgres`. */
  readonly name: string;
  /** A tag plus `@sha256:` digest, e.g. `postgres:18@sha256:…`. */
  readonly reference: string;
  /** Why this image is pinned, in words a reviewer can act on. */
  readonly reason: string;
}

export interface DependencyRegister {
  readonly version: number;
  readonly packages: readonly PinnedPackage[];
  readonly images: readonly PinnedImage[];
}

export interface RegisterReadResult {
  readonly register: DependencyRegister;
  readonly errors: readonly string[];
}

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const digestReference =
  /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::\d+)?:[A-Za-z0-9][\w.-]*@sha256:[a-f0-9]{64}$/;

const requiredFields = ["name", "reason"] as const;
const minimumReasonLength = 10;

export function registerFilePath(
  repoRoot: string,
  fileName: string = dependencyRegisterFileName,
): string {
  return path.resolve(repoRoot, fileName);
}

export function isExactVersion(value: unknown): value is string {
  return typeof value === "string" && exactVersion.test(value);
}

export function isDigestReference(value: unknown): value is string {
  return typeof value === "string" && digestReference.test(value);
}

export function isPackageName(value: unknown): value is string {
  return typeof value === "string" && packageName.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(entry: Record<string, unknown>, field: string): string | undefined {
  const value = entry[field];

  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Reads the register. A missing file is an error, never an empty register. */
export function readRegister(file: string): RegisterReadResult {
  let raw: string;

  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {
      register: { version: 0, packages: [], images: [] },
      errors: [
        `${path.basename(file)} is missing. It is checked in at the repository root and is the ` +
          "only place a pinned version or image digest is chosen; create it with " +
          '{"version": 1, "packages": [], "images": []} if nothing is pinned.',
      ],
    };
  }

  try {
    return parseRegisterValue(JSON.parse(raw));
  } catch (error) {
    return {
      register: { version: 0, packages: [], images: [] },
      errors: [`${path.basename(file)} is not valid JSON: ${(error as Error).message}`],
    };
  }
}

export function parseRegisterValue(raw: unknown): {
  register: DependencyRegister;
  errors: string[];
} {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return {
      register: { version: 0, packages: [], images: [] },
      errors: ["the dependency register must be a JSON object."],
    };
  }

  const version = raw["version"];

  if (version !== 1) {
    errors.push(
      `"version" must be 1, found ${JSON.stringify(version)}. Bump it in a migration, not silently.`,
    );
  }

  const packages = parsePackages(raw["packages"], errors);
  const images = parseImages(raw["images"], errors);

  return {
    register: { version: typeof version === "number" ? version : 0, packages, images },
    errors,
  };
}

function readEntries(
  value: unknown,
  section: string,
  errors: string[],
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    errors.push(`"${section}" must be an array, found ${JSON.stringify(value)}.`);
    return [];
  }

  const entries: Record<string, unknown>[] = [];

  value.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      errors.push(`${section}[${index}] must be an object.`);
      return;
    }

    const missing = [...requiredFields, section === "packages" ? "version" : "reference"].filter(
      (field) => stringField(candidate, field) === undefined,
    );

    if (missing.length > 0) {
      errors.push(`${section}[${index}] is missing a non-empty ${missing.join(", ")}.`);
      return;
    }

    const reason = String(candidate["reason"]).trim();

    if (reason.length < minimumReasonLength) {
      errors.push(
        `${section}[${index}] (${String(candidate["name"])}) has a reason too short to review ` +
          `("${reason}"). Say why the pin exists, not just that it does.`,
      );
      return;
    }

    entries.push(candidate);
  });

  return entries;
}

function duplicateNames(entries: readonly Record<string, unknown>[], section: string): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const name = String(entry["name"]).trim();

    if (seen.has(name)) {
      errors.push(`${section} pins "${name}" twice; the second pin cannot mean anything.`);
    }

    seen.add(name);
  }

  return errors;
}

function parsePackages(value: unknown, errors: string[]): PinnedPackage[] {
  const entries = readEntries(value, "packages", errors);
  errors.push(...duplicateNames(entries, "packages"));

  const packages: PinnedPackage[] = [];

  for (const [index, entry] of entries.entries()) {
    const name = String(entry["name"]).trim();
    const version = entry["version"];

    if (!isPackageName(name)) {
      errors.push(`packages[${index}] has invalid package name "${name}".`);
      continue;
    }

    if (!isExactVersion(version)) {
      errors.push(
        `packages[${index}] (${name}) must pin an exact version, found ${JSON.stringify(version)}. ` +
          "Use 1.2.3, never ^1.2.3, ~1.2.3, latest or a git ref: a pin that can resolve twice is not a pin.",
      );
      continue;
    }

    packages.push({ name, version, reason: String(entry["reason"]).trim() });
  }

  return packages;
}

function parseImages(value: unknown, errors: string[]): PinnedImage[] {
  const entries = readEntries(value, "images", errors);
  errors.push(...duplicateNames(entries, "images"));

  const images: PinnedImage[] = [];

  for (const [index, entry] of entries.entries()) {
    const name = String(entry["name"]).trim();
    const reference = entry["reference"];

    if (!isDigestReference(reference)) {
      errors.push(
        `images[${index}] (${name}) must pin a tag and a digest, found ${JSON.stringify(reference)}. ` +
          "Write postgres:18@sha256:<64 hex>; a tag alone is a moving target.",
      );
      continue;
    }

    images.push({ name, reference, reason: String(entry["reason"]).trim() });
  }

  return images;
}
