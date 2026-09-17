import { describe, expect, it } from "vitest";

// PROOF (reverted in the next commit): a transient failure of the kind the e2e
// tier is allowed to retry. The run must go green with one retry, and the retry
// must be visible on the pull request.
let attempts = 0;

describe("flake proof", () => {
  it("passes only once it has been retried", () => {
    attempts += 1;
    expect(attempts).toBeGreaterThan(1);
  });
});
