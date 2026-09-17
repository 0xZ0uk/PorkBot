import { expect, it } from "vitest";

// Fails on purpose: the only honest way to prove a quarantine entry is honoured
// is to show that the test did not run. If the ledger is ignored, this fails.
it("must be skipped while it is quarantined", () => {
  expect.fail("this test ran, so the quarantine ledger was not applied");
});
