import { readFileSync } from "node:fs";
import path from "node:path";
import { composeServiceBlock, composeServices } from "../deployment/compose.ts";

/**
 * The image size budgets: `image-budgets.json` at the repository root is the
 * one place a built service image's maximum size is stated. "The images are
 * small" is a claim; this file is the number the claim is checked against, so
 * an image that grows — a toolchain that leaks into a runtime, a dependency
 * added without looking — fails CI with a name rather than being discovered on
 * a host's disk.
 *
 * A budget is a ceiling, not a target: each entry records the measured size it
 * was set from, so a reviewer can see the headroom and a later PR can tighten
 * the number when the image shrinks.
 */

export const imageBudgetsFileName = "image-budgets.json";

export interface ImageBudget {
  /** The built image's name without a tag, e.g. `porkbot/api`. */
  readonly name: string;
  /** The ceiling in whole MiB (1024 KiB). */
  readonly budgetMiB: number;
  /** Why the ceiling is this number, in words a reviewer can act on. */
  readonly reason: string;
}

export interface ImageBudgetRegister {
  readonly version: number;
  readonly images: readonly ImageBudget[];
}

export interface BuiltServiceImage {
  /** The compose service, e.g. `api`. */
  readonly service: string;
  /** The image name without a tag, e.g. `porkbot/api`. */
  readonly name: string;
  /** The Dockerfile target the service builds. */
  readonly target: string;
}

export interface BudgetReadResult {
  readonly register: ImageBudgetRegister;
  readonly errors: readonly string[];
}

const minimumReasonLength = 10;
const requiredFields = ["name", "reason"] as const;

export function imageBudgetsFilePath(repoRoot: string): string {
  return path.resolve(repoRoot, imageBudgetsFileName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(entry: Record<string, unknown>, field: string): string | undefined {
  const value = entry[field];

  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Reads the budget register. A missing file is an error, never an empty one. */
export function readBudgets(file: string): BudgetReadResult {
  let raw: string;

  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {
      register: { version: 0, images: [] },
      errors: [
        `${path.basename(file)} is missing. It is checked in at the repository root and is the ` +
          "only place a built image's size ceiling is stated; create it with " +
          '{"version": 1, "images": []} if nothing is built yet.',
      ],
    };
  }

  try {
    return parseBudgetsValue(JSON.parse(raw));
  } catch (error) {
    return {
      register: { version: 0, images: [] },
      errors: [`${path.basename(file)} is not valid JSON: ${(error as Error).message}`],
    };
  }
}

export function parseBudgetsValue(raw: unknown): BudgetReadResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return {
      register: { version: 0, images: [] },
      errors: ["the image budget register must be a JSON object."],
    };
  }

  const version = raw["version"];

  if (version !== 1) {
    errors.push(
      `"version" must be 1, found ${JSON.stringify(version)}. Bump it in a migration, not silently.`,
    );
  }

  const value = raw["images"];

  if (!Array.isArray(value)) {
    errors.push(`"images" must be an array, found ${JSON.stringify(value)}.`);

    return {
      register: { version: typeof version === "number" ? version : 0, images: [] },
      errors,
    };
  }

  const images: ImageBudget[] = [];
  const seen = new Set<string>();

  value.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      errors.push(`images[${index}] must be an object.`);
      return;
    }

    const missing: string[] = requiredFields.filter(
      (field) => stringField(candidate, field) === undefined,
    );

    if (candidate["budgetMiB"] === undefined || candidate["budgetMiB"] === null) {
      missing.push("budgetMiB");
    }

    if (missing.length > 0) {
      errors.push(`images[${index}] is missing a non-empty ${missing.join(", ")}.`);
      return;
    }

    const name = String(candidate["name"]).trim();
    const budgetMiB = candidate["budgetMiB"];
    const reason = String(candidate["reason"]).trim();

    if (seen.has(name)) {
      errors.push(
        `images[${index}] pins a budget for "${name}" twice; the second cannot mean anything.`,
      );
      return;
    }

    if (typeof budgetMiB !== "number" || !Number.isInteger(budgetMiB) || budgetMiB <= 0) {
      errors.push(
        `images[${index}] (${name}) must state budgetMiB as a positive whole number, found ` +
          `${JSON.stringify(budgetMiB)}. The ceiling is a number a diff can read, not a mood.`,
      );
      return;
    }

    if (reason.length < minimumReasonLength) {
      errors.push(
        `images[${index}] (${name}) has a reason too short to review ` +
          `("${reason}"). Say why the ceiling is this number — the measured size it came from — ` +
          "not just that it has one.",
      );
      return;
    }

    seen.add(name);
    images.push({ name, budgetMiB, reason });
  });

  return {
    register: { version: typeof version === "number" ? version : 0, images },
    errors,
  };
}

/**
 * The images this repository builds: every deploy compose service that names a
 * Dockerfile `target`. Pulled images (Postgres) carry digests in
 * dependencies.json instead; only built images grow from a diff here.
 */
export function builtServiceImages(composeText: string): BuiltServiceImage[] {
  const images: BuiltServiceImage[] = [];

  for (const service of composeServices(composeText)) {
    const block = composeServiceBlock(composeText, service) ?? "";
    const target = /^\s+target:\s*(\S+)\s*$/m.exec(block)?.[1];
    // The tag half is a `${PORKBOT_IMAGE_TAG:?…}` expression whose message
    // carries spaces, so the value runs to the end of the line and the name is
    // the part before its first colon.
    const reference = /^\s+image:\s*(.+)$/m.exec(block)?.[1]?.trim();

    if (target === undefined || reference === undefined) {
      continue;
    }

    // `porkbot/api:${PORKBOT_IMAGE_TAG…}` → `porkbot/api`; a name never carries
    // a colon, a tag always follows one.
    const name = reference.split(":", 1)[0] ?? reference;

    images.push({ service, name, target });
  }

  return images;
}
