import { describe, expect, it } from "vitest";
import { isProviderFailure, PROVIDER_FAILURE_KINDS } from "./failures.ts";

/**
 * The guard lifecycle code uses to tell a classified provider failure from a
 * programming error. Degradation — lexical fallback, continuing a run without
 * an index — is only correct for the former, so the guard is exercised over
 * every kind, over an `Error` carrying one, and over the shapes it must refuse.
 */
describe("the provider failure guard", () => {
  it("accepts every kind in the vocabulary on an Error", () => {
    for (const kind of PROVIDER_FAILURE_KINDS) {
      const error = Object.assign(new Error("provider failed"), { kind });
      expect(isProviderFailure(error)).toBe(true);
    }
  });

  it("refuses anything that is not a classified failure", () => {
    const rejected = [
      undefined,
      null,
      "timed_out",
      42,
      new Error("plain"),
      { kind: "timed_out" },
      Object.assign(new Error("bad kind"), { kind: "unknown" }),
      Object.assign(new Error("bad kind"), { kind: 1 }),
      Object.assign(new Error("bad kind"), { kind: null }),
    ];

    for (const value of rejected) {
      expect(isProviderFailure(value), `${String(value)} was accepted`).toBe(false);
    }
  });
});
