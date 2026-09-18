import { describe, expect, it } from "vitest";
import {
  decideEgress,
  EMPTY_EGRESS_ALLOWLIST,
  isHostAllowed,
  parseEgressAllowlist,
} from "./egress-policy.ts";
import type { EgressHostRejection, InvalidEgressHost } from "./egress-policy.ts";

/**
 * The allowlist is what tells "reach this host" apart from "ask the operator",
 * so the suite pins both halves: parsing refuses one bad entry instead of
 * shipping a list nobody meant, and matching treats `example.com`,
 * `*.example.com` and an IPv4 literal exactly as documented. Address safety is
 * deliberately absent here — there is no private-range opinion to drift from
 * the URL-safety module's.
 */

function rejection(entries: readonly string[]): InvalidEgressHost | undefined {
  try {
    parseEgressAllowlist(entries);
  } catch (thrown) {
    return thrown as InvalidEgressHost;
  }

  return undefined;
}

describe("parsing the egress allowlist", () => {
  it("accepts hosts, wildcards and IPv4 literals", () => {
    const allowlist = parseEgressAllowlist(["example.com", "*.example.org", "203.0.113.7"]);

    expect(allowlist.rules).toEqual([
      { kind: "host", host: "example.com" },
      { kind: "subdomains", domain: "example.org" },
      { kind: "host", host: "203.0.113.7" },
    ]);
  });

  it("normalizes case, whitespace and a trailing dot", () => {
    expect(parseEgressAllowlist(["  ExAmPle.COM.  "]).rules).toEqual([
      { kind: "host", host: "example.com" },
    ]);
  });

  it("starts from a fail-closed empty list", () => {
    expect(EMPTY_EGRESS_ALLOWLIST.rules).toEqual([]);
    expect(parseEgressAllowlist([])).toEqual({ rules: [] });
  });

  it("names the rule a bad entry broke", () => {
    const cases: readonly [readonly string[], EgressHostRejection][] = [
      [["   "], "blank"],
      [["https://example.com"], "scheme"],
      [["user:pass@example.com"], "credentials"],
      [["example.com:8443"], "port"],
      [["example.com/path"], "path"],
      [["*.com*"], "wildcard"],
      [["*"], "wildcard"],
      [["*."], "wildcard"],
      [["*.203.0.113.7"], "wildcard"],
      [["not a host"], "malformed"],
      [["-example.com"], "malformed"],
      [["example..com"], "malformed"],
      [["256.0.0.1"], "malformed"],
      [["example.com", "EXAMPLE.com"], "duplicate"],
    ];

    for (const [entries, reason] of cases) {
      const error = rejection(entries);

      expect(error?.name).toBe("InvalidEgressHost");
      expect(error?.reason).toBe(reason);
      expect(error?.message).toContain(entries[entries.length - 1] ?? "");
    }
  });
});

describe("matching hosts", () => {
  const allowlist = parseEgressAllowlist(["example.com", "*.example.org", "203.0.113.7"]);

  it("matches a listed host exactly", () => {
    expect(isHostAllowed(allowlist, "example.com")).toBe(true);
    expect(isHostAllowed(allowlist, "EXAMPLE.com.")).toBe(true);
    expect(isHostAllowed(allowlist, "203.0.113.7")).toBe(true);
  });

  it("matches subdomains at any depth without matching the apex", () => {
    expect(isHostAllowed(allowlist, "a.example.org")).toBe(true);
    expect(isHostAllowed(allowlist, "a.b.example.org")).toBe(true);
    expect(isHostAllowed(allowlist, "example.org")).toBe(false);
  });

  it("does not match a lookalike suffix", () => {
    expect(isHostAllowed(allowlist, "notexample.com")).toBe(false);
    expect(isHostAllowed(allowlist, "example.com.evil.test")).toBe(false);
    expect(isHostAllowed(allowlist, "")).toBe(false);
  });
});

describe("deciding egress for a destination", () => {
  const allowlist = parseEgressAllowlist(["example.com", "*.example.org"]);

  it("proceeds for a host on the list", () => {
    expect(decideEgress(allowlist, "https://example.com/page?q=1")).toEqual({
      decision: "allowed",
      host: "example.com",
    });
  });

  it("asks the operator about a host that is not", () => {
    expect(decideEgress(allowlist, "https://other.test/page")).toEqual({
      decision: "needs_approval",
      host: "other.test",
      url: "https://other.test/page",
    });
  });

  it("asks about everything when the list is empty", () => {
    expect(decideEgress(EMPTY_EGRESS_ALLOWLIST, "https://example.com/")).toEqual({
      decision: "needs_approval",
      host: "example.com",
      url: "https://example.com/",
    });
  });

  it("refuses a destination that cannot be attributed to a host", () => {
    for (const url of ["", "not a url", "mailto:operator@example.com", "file:///etc/passwd"]) {
      expect(decideEgress(allowlist, url)).toEqual({ decision: "refused", reason: "invalid_url" });
    }
  });

  it("decides on the host even when the URL carries a port, path or credentials", () => {
    expect(decideEgress(allowlist, "https://example.com:8443/a/b")).toEqual({
      decision: "allowed",
      host: "example.com",
    });
  });

  it("names the normalized host in every decision", () => {
    expect(decideEgress(allowlist, "HTTPS://EXAMPLE.COM./page")).toEqual({
      decision: "allowed",
      host: "example.com",
    });
    expect(decideEgress(allowlist, "https://Other.TEST./page")).toEqual({
      decision: "needs_approval",
      host: "other.test",
      url: "https://Other.TEST./page",
    });
  });

  it("always gates an IPv6 literal, which the allowlist cannot spell", () => {
    expect(decideEgress(EMPTY_EGRESS_ALLOWLIST, "https://[2001:db8::1]/page")).toEqual({
      decision: "needs_approval",
      host: "[2001:db8::1]",
      url: "https://[2001:db8::1]/page",
    });
  });
});
