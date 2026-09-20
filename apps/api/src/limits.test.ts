import { describe, expect, it } from "vitest";
import {
  bodyCapBytes,
  createRateLimiter,
  createStreamSlots,
  defaultLimits,
  limitsFromEnvironment,
  resolveLimits,
  routeRuleFor,
  routeRules,
} from "./limits.ts";

/**
 * The accounting behind the limits: the fixed window, the connection slots,
 * the route register and the environment parser. These are pure, so they run
 * without an app; the HTTP behaviour they drive is asserted over a real app in
 * `limits-surface.test.ts`.
 */

describe("the route register", () => {
  const rules = routeRules("/rpc");

  it("names the health probe, the whole RPC surface, the webhook ingress, the callback and the file routes", () => {
    expect(rules).toEqual([
      { method: "GET", path: "/healthz", family: "probe" },
      { method: "GET", path: "/livez", family: "probe" },
      { method: "GET", path: "/readyz", family: "probe" },
      { method: "ALL", path: "/rpc/*", family: "rpc" },
      { method: "POST", path: "/webhooks/*", family: "webhook" },
      { method: "GET", path: "/oauth/mcp/callback", family: "webhook" },
      { method: "POST", path: "/threads/:threadId/attachments", family: "upload" },
      { method: "GET", path: "/files/:fileId", family: "rpc" },
    ]);
  });

  it("matches the RPC prefix and everything under it, on any method", () => {
    expect(routeRuleFor(rules, "POST", "/rpc/account/me")?.family).toBe("rpc");
    expect(routeRuleFor(rules, "GET", "/rpc")?.family).toBe("rpc");
    expect(routeRuleFor(rules, "POST", "/rpc")?.family).toBe("rpc");
  });

  it("matches the probe on GET only", () => {
    expect(routeRuleFor(rules, "GET", "/healthz")?.family).toBe("probe");
    expect(routeRuleFor(rules, "GET", "/livez")?.family).toBe("probe");
    expect(routeRuleFor(rules, "GET", "/readyz")?.family).toBe("probe");
    expect(routeRuleFor(rules, "POST", "/healthz")).toBeUndefined();
  });

  it("matches the webhook ingress by prefix, so a source name is not enumerated", () => {
    expect(routeRuleFor(rules, "POST", "/webhooks/github")?.family).toBe("webhook");
    expect(routeRuleFor(rules, "POST", "/webhooks/anything-else")?.family).toBe("webhook");
    expect(routeRuleFor(rules, "GET", "/webhooks/github")).toBeUndefined();
  });

  it("does not invent a rule for an unknown path", () => {
    expect(routeRuleFor(rules, "POST", "/webhookish/github")).toBeUndefined();
    expect(routeRuleFor(rules, "GET", "/rpcish")).toBeUndefined();
  });
});

describe("the fixed-window limiter", () => {
  it("allows up to the budget and refuses the next request", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, now: () => 0 });

    expect(limiter.check("rpc", "actor:1", 3)).toEqual({ allowed: true });
    expect(limiter.check("rpc", "actor:1", 3)).toEqual({ allowed: true });
    expect(limiter.check("rpc", "actor:1", 3)).toEqual({ allowed: true });
    expect(limiter.check("rpc", "actor:1", 3)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it("reports the seconds left in the window, rounded up and never zero", () => {
    const limiter = createRateLimiter({ windowMs: 1_000, now: () => 0 });

    limiter.check("rpc", "actor:1", 1);

    expect(limiter.check("rpc", "actor:1", 1, 1)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.check("rpc", "actor:1", 1, 999)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("opens a fresh window once the old one has passed", () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 1_000, now: () => now });

    limiter.check("rpc", "actor:1", 1);
    expect(limiter.check("rpc", "actor:1", 1)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });

    now = 1_000;

    expect(limiter.check("rpc", "actor:1", 1)).toEqual({ allowed: true });
  });

  it("keys budgets apart by bucket and by principal", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, now: () => 0 });

    limiter.check("authenticated", "actor:1", 1);

    expect(limiter.check("authenticated", "actor:1", 1)).toMatchObject({ allowed: false });
    expect(limiter.check("authenticated", "actor:2", 1)).toEqual({ allowed: true });
    expect(limiter.check("anonymous", "actor:1", 1)).toEqual({ allowed: true });
  });
});

describe("the stream slots", () => {
  it("refuses a principal past its cap and frees the slot on release", () => {
    const slots = createStreamSlots();

    const first = slots.acquire("actor:1", 2);
    const second = slots.acquire("actor:1", 2);

    expect(first.opened).toBe(true);
    expect(second.opened).toBe(true);
    expect(slots.acquire("actor:1", 2)).toEqual({ opened: false, retryAfterSeconds: 1 });

    if (first.opened) {
      first.slot.release();
    }

    expect(slots.acquire("actor:1", 2).opened).toBe(true);
  });

  it("keeps one principal's slots out of another's", () => {
    const slots = createStreamSlots();

    expect(slots.acquire("actor:1", 1).opened).toBe(true);
    expect(slots.acquire("actor:1", 1).opened).toBe(false);
    expect(slots.acquire("actor:2", 1).opened).toBe(true);
  });

  it("releases once even when a close and a cancel race", () => {
    const slots = createStreamSlots();
    const opened = slots.acquire("actor:1", 1);

    if (!opened.opened) {
      throw new Error("expected the first slot to open");
    }

    opened.slot.release();
    opened.slot.release();

    const reopened = slots.acquire("actor:1", 1);

    expect(reopened.opened).toBe(true);

    if (reopened.opened) {
      reopened.slot.release();
    }
  });
});

describe("the configured limits", () => {
  it("applies overrides on top of the registered defaults", () => {
    const limits = resolveLimits({
      authenticated: { requestsPerMinute: 5 },
      webhook: { maxBodyBytes: 1_000 },
    });

    expect(limits.authenticated.requestsPerMinute).toBe(5);
    expect(limits.authenticated.maxConcurrentStreams).toBe(
      defaultLimits.authenticated.maxConcurrentStreams,
    );
    expect(limits.webhook.maxBodyBytes).toBe(1_000);
    expect(limits.webhook.requestsPerMinute).toBe(defaultLimits.webhook.requestsPerMinute);
  });

  it("caps RPC bodies at the larger of the two principals' caps", () => {
    const limits = resolveLimits({
      authenticated: { maxBodyBytes: 100 },
      anonymous: { maxBodyBytes: 200 },
    });

    expect(bodyCapBytes(limits, "rpc")).toBe(200);
    expect(bodyCapBytes(limits, "webhook")).toBe(defaultLimits.webhook.maxBodyBytes);
    expect(bodyCapBytes(limits, "probe")).toBe(200);
    expect(bodyCapBytes(limits, "fallback")).toBe(200);
  });
});

describe("the environment configuration", () => {
  it("takes the registered default when a variable is unset or blank", () => {
    expect(limitsFromEnvironment({})).toEqual(defaultLimits);
    expect(limitsFromEnvironment({ PORKBOT_LIMIT_AUTHENTICATED_PER_MINUTE: "   " })).toEqual(
      defaultLimits,
    );
  });

  it("reads every documented override", () => {
    const limits = limitsFromEnvironment({
      PORKBOT_LIMIT_AUTHENTICATED_PER_MINUTE: "10",
      PORKBOT_LIMIT_ANONYMOUS_PER_MINUTE: "11",
      PORKBOT_LIMIT_WEBHOOK_PER_MINUTE: "12",
      PORKBOT_LIMIT_UPLOAD_PER_MINUTE: "17",
      PORKBOT_LIMIT_PROBE_PER_MINUTE: "13",
      PORKBOT_LIMIT_MAX_STREAMS_PER_ACTOR: "14",
      PORKBOT_LIMIT_MAX_BODY_BYTES: "15",
      PORKBOT_LIMIT_MAX_WEBHOOK_BODY_BYTES: "16",
      PORKBOT_LIMIT_MAX_UPLOAD_BYTES: "18",
    });

    expect(limits).toEqual({
      authenticated: { requestsPerMinute: 10, maxConcurrentStreams: 14, maxBodyBytes: 15 },
      anonymous: { requestsPerMinute: 11, maxConcurrentStreams: 1, maxBodyBytes: 15 },
      webhook: { requestsPerMinute: 12, maxBodyBytes: 16 },
      upload: { requestsPerMinute: 17, maxBodyBytes: 18 },
      probe: { requestsPerMinute: 13 },
    });
  });

  it("refuses a value that is not a positive integer instead of guarding with it", () => {
    for (const value of ["0", "-1", "1.5", "many", "NaN", "Infinity"]) {
      expect(() =>
        limitsFromEnvironment({ PORKBOT_LIMIT_AUTHENTICATED_PER_MINUTE: value }),
      ).toThrow(/PORKBOT_LIMIT_AUTHENTICATED_PER_MINUTE/);
    }
  });
});
