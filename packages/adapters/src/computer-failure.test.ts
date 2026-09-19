import { describe, expect, it } from "vitest";
import { computerFailureKind } from "./computer-failure.ts";
import type { ComputerFailureRule } from "./computer-failure.ts";

/**
 * The shared computer failure decision (slices 7.2 and 7.3, PRD decision 19).
 *
 * Both provider classifiers route through this table, so "the computer is
 * gone" is decided once: a 404 on the machine (or on a command running in one)
 * is `gone`, a 404 on a named thing inside a healthy provider is `not_found`,
 * a refused credential and a quota are what their statuses say, and an
 * unanswered call is `timed_out` regardless of vendor. The vendor rules a
 * caller supplies are provider-specific and are exercised by each provider's
 * own classifier suite; this one pins the shared part and the fall-through to
 * "unclassified" that keeps a guessed kind out of lifecycle code.
 */

const noRules: readonly ComputerFailureRule[] = [];

function kindOf(input: {
  readonly origin?: "http" | "stream" | "transport" | "timeout" | "protocol";
  readonly status?: number;
  readonly message?: string;
  readonly subject?: "machine" | "exec" | "named";
  readonly rules?: readonly ComputerFailureRule[];
}): string | undefined {
  const verdict = computerFailureKind({
    origin: input.origin ?? "http",
    status: input.status,
    message: input.message ?? "",
    subject: input.subject ?? "machine",
    rules: input.rules ?? noRules,
  });

  return verdict?.kind;
}

describe("the shared computer failure decision", () => {
  it("answers a missing machine as gone and a missing named thing as not_found", () => {
    expect(kindOf({ status: 404, subject: "machine" })).toBe("gone");
    expect(kindOf({ status: 404, subject: "exec" })).toBe("gone");
    expect(kindOf({ status: 404, subject: "named" })).toBe("not_found");
  });

  it("answers a refused credential and a quota with the shared vocabulary", () => {
    expect(kindOf({ status: 401 })).toBe("auth_failed");
    expect(kindOf({ status: 403 })).toBe("auth_failed");
    expect(kindOf({ status: 429 })).toBe("rate_limited");
    expect(kindOf({ status: 408 })).toBe("timed_out");
  });

  it("answers an unanswered call as timed_out on any provider", () => {
    expect(kindOf({ origin: "timeout" })).toBe("timed_out");
    expect(kindOf({ origin: "transport" })).toBe("timed_out");
  });

  it("lets a provider's own words decide before the shared statuses", () => {
    // A Docker-shaped rule: a pull stream carries a refusal with no status at
    // all, so the words have to make the decision.
    const rules: readonly ComputerFailureRule[] = [
      { pattern: /toomanyrequests/, kind: "rate_limited" },
      { pattern: /is not running/, kind: "gone" },
    ];

    expect(kindOf({ origin: "stream", message: "toomanyrequests", rules })).toBe("rate_limited");
    expect(kindOf({ status: 409, message: "Container abc is not running", rules })).toBe("gone");
  });

  it("leaves an unknown refusal unclassified rather than guessing", () => {
    expect(kindOf({ status: 500, message: "the control plane fell over" })).toBeUndefined();
    expect(kindOf({ origin: "protocol", status: 418 })).toBeUndefined();
  });
});
