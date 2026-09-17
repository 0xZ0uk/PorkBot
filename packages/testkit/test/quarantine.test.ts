import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { findRepoRoot } from "../src/paths.ts";
import {
  daysBetween,
  entriesFor,
  entryStatuses,
  formatEntries,
  isIsoDate,
  ledgerFilePath,
  maxQuarantineDays,
  parseLedgerValue,
  quarantinePattern,
  readLedger,
  validateLedger,
} from "../src/quarantine/ledger.ts";
import type { QuarantineLedger } from "../src/quarantine/ledger.ts";
import { todayIso } from "../src/vitest/flake-reporter.ts";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(path.join(tmpdir(), "porkbot-quarantine-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// The ledger points at a real test: validating an entry is partly validating that
// the test it names still exists, so the fixture is the file the ledger uses.
const fixtureFile = "packages/testkit/test/fixtures/flake/quarantine.fixture.ts";
const fixtureTitle = "must be skipped while it is quarantined";

function isoDaysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "flake-0001",
    tier: "unit",
    file: fixtureFile,
    test: fixtureTitle,
    owner: "@Z0uk",
    reason: "fails on a cold cache and has not been diagnosed yet",
    issue: "https://github.com/0xZ0uk/PorkBot/issues/19",
    quarantinedOn: isoDaysFromToday(-1),
    expires: isoDaysFromToday(30),
    ...overrides,
  };
}

function ledgerWith(entries: readonly Record<string, unknown>[]): QuarantineLedger {
  const parsed = parseLedgerValue({ version: 1, entries: [...entries] });

  expect(parsed.errors, parsed.errors.join("\n")).toEqual([]);

  return parsed.ledger;
}

function validate(entries: readonly Record<string, unknown>[], today = todayIso()): string[] {
  return validateLedger(ledgerWith(entries), { repoRoot, today });
}

describe("the quarantine ledger's schema", () => {
  it("accepts an entry that names a test, an owner, a reason and an expiry", () => {
    expect(validate([entry()])).toEqual([]);
  });

  it("accepts an empty ledger", () => {
    expect(validateLedger({ version: 1, entries: [] }, { repoRoot, today: todayIso() })).toEqual(
      [],
    );
  });

  it("accepts a checked-in ledger file that nothing has been written to yet", () => {
    const file = path.join(scratch, "empty-quarantine.json");

    writeFileSync(file, '{ "version": 1, "entries": [] }');

    const { ledger, errors } = readLedger(file);

    expect(errors).toEqual([]);
    expect(ledger.entries).toEqual([]);
  });

  it.each([
    ["id", "entries[0] is missing a non-empty id."],
    ["owner", "entries[0] is missing a non-empty owner."],
    ["test", "entries[0] is missing a non-empty test."],
    ["expires", "entries[0] is missing a non-empty expires."],
  ])("rejects an entry with no %s", (field, message) => {
    const { errors } = parseLedgerValue({ version: 1, entries: [entry({ [field]: "  " })] });

    expect(errors.join("\n")).toContain(message);
  });

  it("rejects a version it does not know", () => {
    const { errors } = parseLedgerValue({ version: 2, entries: [] });

    expect(errors.join("\n")).toContain('"version" must be 1');
  });

  it("rejects a tier that is not one of the three", () => {
    const { errors } = parseLedgerValue({ version: 1, entries: [entry({ tier: "nightly" })] });

    expect(errors.join("\n")).toContain('tier "nightly"; expected one of unit, integration, e2e');
  });

  it("rejects a reason too short to review and an issue that is not an issue", () => {
    const { errors } = parseLedgerValue({
      version: 1,
      entries: [entry({ reason: "flaky", issue: "TODO" })],
    });

    expect(errors.join("\n")).toContain("reason is too short to review");
    expect(errors.join("\n")).toContain("issue must be a GitHub issue URL");
  });

  it("rejects a date that is not an ISO date", () => {
    const { errors } = parseLedgerValue({
      version: 1,
      entries: [entry({ expires: "31/12/2026" })],
    });

    expect(errors.join("\n")).toContain("expires must be an ISO date (YYYY-MM-DD)");
    expect(isIsoDate("31/12/2026")).toBe(false);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate(isoDaysFromToday(30))).toBe(true);
  });

  it("rejects a file that is not a repository-relative path", () => {
    const { errors } = parseLedgerValue({ version: 1, entries: [entry({ file: "/etc/hosts" })] });

    expect(errors.join("\n")).toContain("file must be a repository-relative path");
  });

  it("reports a missing ledger file instead of pretending it is empty", () => {
    const { ledger, errors } = readLedger(path.join(scratch, "does-not-exist.json"));

    expect(ledger.entries).toEqual([]);
    expect(errors.join("\n")).toContain("is missing");
  });

  it("reports invalid JSON", () => {
    const file = path.join(scratch, "broken.json");

    writeFileSync(file, "{ not json");

    expect(readLedger(file).errors.join("\n")).toContain("is not valid JSON");
  });
});

describe("what makes an entry stale", () => {
  it("fails an expired entry, and says how long it has been expired", () => {
    const errors = validate([entry({ expires: isoDaysFromToday(-3) })]);

    expect(errors.join("\n")).toContain("quarantine expired 3 day(s) ago");
  });

  it("keeps an entry that expires today, but calls it out as due", () => {
    // The expiry date is inclusive: an entry is allowed through the day it
    // expires. What matters is that the day is visible, which is what the
    // expiring-soon warning and its remaining-day count are for.
    expect(validate([entry({ expires: isoDaysFromToday(0) })])).toEqual([]);

    const [status] = entryStatuses(
      [...ledgerWith([entry({ expires: isoDaysFromToday(0) })]).entries],
      todayIso(),
    );

    expect(status?.remainingDays).toBe(0);
    expect(status?.expiringSoon).toBe(true);
  });

  it("fails a quarantine that is really an archive", () => {
    const errors = validate([entry({ expires: isoDaysFromToday(maxQuarantineDays + 1) })]);

    expect(errors.join("\n")).toContain(`past the ${maxQuarantineDays}-day limit`);
  });

  it("fails an entry whose test no longer exists", () => {
    const errors = validate([entry({ test: "a test that was renamed away" })]);

    expect(errors.join("\n")).toContain("no test titled");
  });

  it("fails an entry that would skip more than one test", () => {
    const errors = validate([
      entry({
        file: "packages/testkit/test/fixtures/flake/ambiguous.fixture.ts",
        test: "reports on the shared title",
      }),
    ]);

    expect(errors.join("\n")).toContain("appears 2 times");
  });

  it("fails an entry pointing at a file that does not exist", () => {
    const errors = validate([entry({ file: "packages/testkit/test/gone.test.ts" })]);

    expect(errors.join("\n")).toContain("does not exist");
  });

  it("fails duplicate ids and duplicate entries", () => {
    const errors = validate([entry(), entry({ id: "flake-0001" })]);

    expect(errors.join("\n")).toContain("duplicate id");
    expect(errors.join("\n")).toContain("duplicate entry for");
  });

  it("fails an expiry before the quarantine date and a future quarantine date", () => {
    const errors = validate([
      entry({ quarantinedOn: isoDaysFromToday(2), expires: isoDaysFromToday(1) }),
    ]);

    expect(errors.join("\n")).toContain("is before quarantinedOn");
    expect(errors.join("\n")).toContain("quarantinedOn");
    expect(errors.join("\n")).toContain("is in the future");
  });
});

describe("which entries a tier is responsible for", () => {
  const ledger = parseLedgerValue({
    version: 1,
    entries: [
      entry({ id: "unit-entry", tier: "unit" }),
      entry({
        id: "integration-entry",
        tier: "integration",
        file: "packages/db/test/integration/postgres.integration.test.ts",
        test: "is a real server and not a stub",
      }),
      entry({
        id: "elsewhere",
        tier: "unit",
        file: "apps/api/test/e2e/health.e2e.test.ts",
        test: "starts, serves /healthz over HTTP and stops on SIGTERM",
      }),
    ],
  }).ledger;

  it("selects by tier and by package, so one package's entry cannot skip another's test", () => {
    const selected = entriesFor(ledger, {
      tier: "unit",
      repoRoot,
      packageRoot: path.join(repoRoot, "packages", "testkit"),
    });

    expect(selected.map((selectedEntry) => selectedEntry.id)).toEqual(["unit-entry"]);
  });

  it("leaves the other tiers alone", () => {
    const selected = entriesFor(ledger, {
      tier: "integration",
      repoRoot,
      packageRoot: path.join(repoRoot, "packages", "db"),
    });

    expect(selected.map((selectedEntry) => selectedEntry.id)).toEqual(["integration-entry"]);
  });
});

describe("the exclusion pattern", () => {
  it("is undefined for an empty ledger, so nothing changes when nothing is quarantined", () => {
    expect(quarantinePattern([])).toBeUndefined();
  });

  it("skips exactly the named tests, including titles that look like regex syntax", () => {
    const entries = ledgerWith([
      entry({ id: "flake-0001", test: "adds (1) + (2) [fast]" }),
      entry({ id: "flake-0002", test: "handles a path like a.b.c" }),
    ]).entries;
    const pattern = new RegExp(quarantinePattern(entries) ?? "");

    expect(pattern.test("adds (1) + (2) [fast]")).toBe(false);
    expect(pattern.test("handles a path like a.b.c")).toBe(false);
    expect(pattern.test("adds 1 + 2 fast")).toBe(true);
    expect(pattern.test("unrelated test")).toBe(true);
  });
});

describe("the reviewer-facing summary", () => {
  it("names the owner, the reason and the deadline", () => {
    const markdown = formatEntries(ledgerWith([entry()]).entries, todayIso());

    expect(markdown).toContain("@Z0uk");
    expect(markdown).toContain("fails on a cold cache");
    expect(markdown).toContain("https://github.com/0xZ0uk/PorkBot/issues/19");
    expect(markdown).toContain("30 day(s)");
  });

  it("says so in words when nothing is quarantined", () => {
    expect(formatEntries([], todayIso())).toBe("No test is quarantined.");
  });
});

describe("day arithmetic", () => {
  it("counts whole days in both directions", () => {
    expect(daysBetween("2026-09-17", "2026-09-20")).toBe(3);
    expect(daysBetween("2026-09-20", "2026-09-17")).toBe(-3);
    expect(daysBetween("2026-09-17", "2026-09-17")).toBe(0);
  });
});

describe("ledger locations", () => {
  it("resolves from the repository root", () => {
    expect(ledgerFilePath(repoRoot)).toBe(path.join(repoRoot, "quarantine.json"));
  });

  it("honours a relative scratch directory for tests that need one", () => {
    mkdirSync(path.join(scratch, "nested"), { recursive: true });

    expect(ledgerFilePath(scratch, "nested/quarantine.json")).toBe(
      path.join(scratch, "nested", "quarantine.json"),
    );
  });
});
