import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isInside } from "../paths.ts";

/**
 * The quarantine ledger: the one place a test is allowed to not run, with the
 * three fields that make that a decision rather than a shrug — an owner, a
 * reason and an expiry. Everything in this module exists to make a stale entry
 * loud: an expired entry is an error, not a warning, and an entry whose test was
 * renamed or deleted is an error too, because a ledger that no longer describes
 * real tests is a ledger nobody reads.
 */

export const tiers = ["unit", "integration", "e2e"] as const;

export type Tier = (typeof tiers)[number];

export const quarantineLedgerFileName = "quarantine.json";

/**
 * A quarantined test is a debt, not a state. Nothing may sit in the ledger for
 * longer than this without a human re-signing the entry with a new expiry.
 */
export const maxQuarantineDays = 90;

/** Entries closer to expiry than this get a warning on every run that reads them. */
export const expiryWarningDays = 14;

export interface QuarantineEntry {
  /** Stable handle, referenced in review ("flake-0001"). */
  readonly id: string;
  /** The tier that skips it. Unit and integration never skip silently by retry. */
  readonly tier: Tier;
  /** Path from the repository root, so the entry reads the same from anywhere. */
  readonly file: string;
  /** The test title as written in the file. Must be unique in that file. */
  readonly test: string;
  /** A person, not a team alias: whoever fixes it. */
  readonly owner: string;
  /** Why it is quarantined, in words a reviewer can act on. */
  readonly reason: string;
  /** The issue tracking the fix. */
  readonly issue: string;
  /** When it was quarantined (ISO date). */
  readonly quarantinedOn: string;
  /** When it stops being allowed to be quarantined (ISO date). */
  readonly expires: string;
}

export interface QuarantineLedger {
  readonly version: number;
  readonly entries: readonly QuarantineEntry[];
}

export interface LedgerReadResult {
  readonly ledger: QuarantineLedger;
  readonly errors: readonly string[];
}

export interface LedgerValidationOptions {
  readonly repoRoot: string;
  /** ISO date treated as "now". Injected so tests are not clock-dependent. */
  readonly today: string;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const issueUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;

const requiredEntryFields = [
  "id",
  "tier",
  "file",
  "test",
  "owner",
  "reason",
  "issue",
  "quarantinedOn",
  "expires",
] as const;

export function ledgerFilePath(
  repoRoot: string,
  fileName: string = quarantineLedgerFileName,
): string {
  return path.resolve(repoRoot, fileName);
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (tiers as readonly string[]).includes(value);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !isoDate.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Whole days from `from` to `to`, both ISO dates. Negative when `to` is past. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the ledger file. A missing file is an error, never an empty ledger. */
export function readLedger(file: string): LedgerReadResult {
  let raw: string;

  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {
      ledger: { version: 0, entries: [] },
      errors: [
        `${path.basename(file)} is missing. It is checked in at the repository root and is the only ` +
          'place a test may be quarantined; create it with {"version": 1, "entries": []} if nothing is.',
      ],
    };
  }

  try {
    return parseLedgerValue(JSON.parse(raw));
  } catch (error) {
    return {
      ledger: { version: 0, entries: [] },
      errors: [`${path.basename(file)} is not valid JSON: ${(error as Error).message}`],
    };
  }
}

/** Structural shape only: field presence, types and date format. */
export function parseLedgerValue(raw: unknown): { ledger: QuarantineLedger; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ledger: { version: 0, entries: [] }, errors: ["the ledger must be a JSON object."] };
  }

  const version = raw["version"];

  if (version !== 1) {
    errors.push(
      `"version" must be 1, found ${JSON.stringify(version)}. Bump it in a migration, not silently.`,
    );
  }

  const rawEntries = raw["entries"];

  if (!Array.isArray(rawEntries)) {
    return {
      ledger: { version: typeof version === "number" ? version : 0, entries: [] },
      errors: [...errors, `"entries" must be an array, found ${JSON.stringify(rawEntries)}.`],
    };
  }

  const entries: QuarantineEntry[] = [];

  rawEntries.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      errors.push(`entries[${index}] must be an object.`);
      return;
    }

    const missing = requiredEntryFields.filter((field) => {
      const value = candidate[field];
      return typeof value !== "string" || value.trim() === "";
    });

    if (missing.length > 0) {
      errors.push(`entries[${index}] is missing a non-empty ${missing.join(", ")}.`);
      return;
    }

    const tier = candidate["tier"];

    if (!isTier(tier)) {
      errors.push(
        `entries[${index}] (${String(candidate["id"])}) has tier ${JSON.stringify(tier)}; expected one of ${tiers.join(", ")}.`,
      );
      return;
    }

    const values = Object.fromEntries(
      requiredEntryFields.map((field) => [field, String(candidate[field]).trim()]),
    ) as Record<(typeof requiredEntryFields)[number], string>;

    const fieldErrors: string[] = [];

    if (values.reason.length < 10) {
      fieldErrors.push(`reason is too short to review ("${values.reason}").`);
    }

    if (!issueUrl.test(values.issue)) {
      fieldErrors.push(`issue must be a GitHub issue URL, found "${values.issue}".`);
    }

    for (const field of ["quarantinedOn", "expires"] as const) {
      if (!isIsoDate(values[field])) {
        fieldErrors.push(`${field} must be an ISO date (YYYY-MM-DD), found "${values[field]}".`);
      }
    }

    if (values.file.startsWith("/") || values.file.startsWith("..") || !values.file.includes("/")) {
      fieldErrors.push(`file must be a repository-relative path, found "${values.file}".`);
    }

    if (fieldErrors.length > 0) {
      errors.push(...fieldErrors.map((message) => `entries[${index}] (${values.id}): ${message}`));
      return;
    }

    entries.push({
      id: values.id,
      tier,
      file: values.file,
      test: values.test,
      owner: values.owner,
      reason: values.reason,
      issue: values.issue,
      quarantinedOn: values.quarantinedOn,
      expires: values.expires,
    });
  });

  return { ledger: { version: typeof version === "number" ? version : 0, entries }, errors };
}

/** Occurrences of `title` as a quoted string literal: how the test is declared. */
function titleOccurrences(source: string, title: string): number {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = new RegExp(`(["'\`])${escaped}\\1`, "g");

  return source.match(quoted)?.length ?? 0;
}

/**
 * Everything a ledger can get wrong that structure alone cannot see: expired
 * entries, entries pointing at tests that no longer exist, entries that would
 * silently skip a sibling with the same title, duplicate ids, and entries that
 * were archived rather than scheduled (`expires` a year out).
 */
export function validateLedger(
  ledger: QuarantineLedger,
  options: LedgerValidationOptions,
): string[] {
  const { repoRoot, today } = options;
  const errors: string[] = [];
  const seenIds = new Map<string, number>();
  const seenTests = new Map<string, number>();

  ledger.entries.forEach((entry, index) => {
    const position = `entries[${index}] (${entry.id})`;
    const previousId = seenIds.get(entry.id);

    if (previousId !== undefined) {
      errors.push(`${position}: duplicate id, already used by entries[${previousId}].`);
    }

    seenIds.set(entry.id, index);

    const testKey = `${entry.file}::${entry.test}`;
    const previousTest = seenTests.get(testKey);

    if (previousTest !== undefined) {
      errors.push(
        `${position}: duplicate entry for ${entry.file} > "${entry.test}" (also entries[${previousTest}]).`,
      );
    }

    seenTests.set(testKey, index);

    const absolute = path.resolve(repoRoot, entry.file);

    if (!isInside(repoRoot, absolute) || !statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      errors.push(
        `${position}: ${entry.file} does not exist. The ledger is only for tests that do.`,
      );
      return;
    }

    const source = readFileSync(absolute, "utf8");
    const occurrences = titleOccurrences(source, entry.test);

    if (occurrences === 0) {
      errors.push(
        `${position}: no test titled "${entry.test}" in ${entry.file}. Rename the entry with the test, ` +
          "or delete the entry: a ledger entry that skips nothing is a lie about coverage.",
      );
    } else if (occurrences > 1) {
      errors.push(
        `${position}: "${entry.test}" appears ${occurrences} times in ${entry.file}, so the entry would skip ` +
          "every one of them. Use the full title of a single test.",
      );
    }

    if (daysBetween(entry.quarantinedOn, entry.expires) < 0) {
      errors.push(
        `${position}: expires (${entry.expires}) is before quarantinedOn (${entry.quarantinedOn}).`,
      );
    }

    const remaining = daysBetween(today, entry.expires);

    if (remaining < 0) {
      errors.push(
        `${position}: quarantine expired ${-remaining} day(s) ago (expires ${entry.expires}). Fix the test, ` +
          "fix the entry, or extend it deliberately with a new expiry — but it cannot stay expired.",
      );
    }

    if (remaining > maxQuarantineDays) {
      errors.push(
        `${position}: expires ${entry.expires} is ${remaining} days out, past the ${maxQuarantineDays}-day limit. ` +
          "Quarantine is a deadline, not an archive.",
      );
    }

    if (daysBetween(entry.quarantinedOn, today) < 0) {
      errors.push(`${position}: quarantinedOn (${entry.quarantinedOn}) is in the future.`);
    }
  });

  return errors;
}

/** The entries a single tier in a single package is responsible for skipping. */
export function entriesFor(
  ledger: QuarantineLedger,
  filter: { tier: Tier; repoRoot: string; packageRoot: string },
): QuarantineEntry[] {
  return ledger.entries.filter(
    (entry) =>
      entry.tier === filter.tier &&
      isInside(filter.packageRoot, path.resolve(filter.repoRoot, entry.file)),
  );
}

/**
 * A negative lookahead over the full test name. This is how a quarantined test
 * stops running: vitest reports it as skipped, so the skip is visible in the run
 * output and in the count, rather than vanishing from the file list. When the
 * ledger has no entry for this tier it returns `undefined`, so a clean ledger
 * changes nothing about how the tier runs.
 */
export function quarantinePattern(entries: readonly QuarantineEntry[]): string | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const alternatives = entries.map((entry) => entry.test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  return `^(?!.*(?:${alternatives.join("|")}))`;
}

export interface EntryStatus {
  readonly entry: QuarantineEntry;
  readonly remainingDays: number;
  readonly expiringSoon: boolean;
}

export function entryStatuses(entries: readonly QuarantineEntry[], today: string): EntryStatus[] {
  return entries.map((entry) => {
    const remainingDays = daysBetween(today, entry.expires);

    return { entry, remainingDays, expiringSoon: remainingDays <= expiryWarningDays };
  });
}

/** The markdown a reviewer reads on the pull request. */
export function formatEntries(entries: readonly QuarantineEntry[], today: string): string {
  if (entries.length === 0) {
    return "No test is quarantined.";
  }

  const rows = entryStatuses(entries, today).map(
    ({ entry, remainingDays }) =>
      `| ${entry.id} | ${entry.tier} | \`${entry.file}\` > ${entry.test} | ${entry.owner} | ${entry.reason} | ` +
      `${entry.expires} (${remainingDays} day(s)) | ${entry.issue} |`,
  );

  return [
    "| id | tier | test | owner | reason | expires | issue |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
