import { it } from "vitest";

// Two tests that share a title: a ledger entry naming that title would skip both
// of them, which is why validateLedger() refuses an ambiguous entry.
it("reports on the shared title", () => {});

it("reports on the shared title", () => {});
