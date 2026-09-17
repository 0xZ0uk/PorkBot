import { expect, it } from "vitest";
import { recordAttempt } from "./attempts.ts";

// Fails on the first attempt and passes afterwards: a transient failure of the
// kind the e2e tier is allowed to retry, and the kind the unit tier must not.
it("passes only once it is retried", () => {
  expect(recordAttempt()).toBeGreaterThan(1);
});
