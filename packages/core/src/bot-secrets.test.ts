import { describe, expect, it } from "vitest";
import {
  botSecretCredentialHeader,
  isBotSecretName,
  isBotSecretOrigin,
  parseBotSecretAuth,
  parseBotSecretDestination,
} from "./bot-secrets.ts";

/**
 * The bot-secret vocabulary (slice 9.6): the name and origin shapes a durable
 * row may take, the three authentication modes, and the one header the proxy
 * injects. The last describe is the secrecy property this module exists for:
 * parsing rejects by reason, and the only output that carries a value is the
 * header the server-side proxy boundary asked for.
 */

describe("the name shape", () => {
  it("accepts a lowercase identifier and refuses everything else", () => {
    expect(isBotSecretName("example_api")).toBe(true);
    expect(isBotSecretName("a")).toBe(true);
    expect(isBotSecretName("Example_API")).toBe(false);
    expect(isBotSecretName("1api")).toBe(false);
    expect(isBotSecretName("_api")).toBe(false);
    expect(isBotSecretName("api-key")).toBe(false);
    expect(isBotSecretName("a".repeat(65))).toBe(false);
    expect(isBotSecretName("")).toBe(false);
    expect(isBotSecretName(7)).toBe(false);
  });
});

describe("the origin shape", () => {
  it("accepts only a bare HTTPS origin", () => {
    expect(isBotSecretOrigin("https://api.example.test")).toBe(true);
    expect(isBotSecretOrigin("https://api.example.test/")).toBe(true);
    expect(isBotSecretOrigin("https://api.example.test:8443")).toBe(true);
    expect(isBotSecretOrigin("http://api.example.test")).toBe(false);
    expect(isBotSecretOrigin("https://api.example.test/v1")).toBe(false);
    expect(isBotSecretOrigin("https://api.example.test?x=1")).toBe(false);
    expect(isBotSecretOrigin("https://api.example.test#frag")).toBe(false);
    expect(isBotSecretOrigin("https://user:pass@api.example.test")).toBe(false);
    expect(isBotSecretOrigin("not a url")).toBe(false);
  });
});

describe("the authentication shapes", () => {
  it("accepts bearer, a usable named header and basic", () => {
    expect(parseBotSecretAuth({ type: "bearer" })).toEqual({ type: "bearer" });
    expect(parseBotSecretAuth({ type: "header", name: "X-Api-Key" })).toEqual({
      type: "header",
      name: "X-Api-Key",
    });
    expect(parseBotSecretAuth({ type: "basic", username: "api-user" })).toEqual({
      type: "basic",
      username: "api-user",
    });
  });

  it("refuses framing, hop-by-hop and proxy headers", () => {
    for (const name of [
      "host",
      "content-length",
      "transfer-encoding",
      "connection",
      "cookie",
      "x-porkbot-proxy-token",
      "X-Forwarded-For",
      "sec-fetch-site",
      "proxy-authorization",
    ]) {
      expect(parseBotSecretAuth({ type: "header", name }), name).toBeUndefined();
    }
  });

  it("refuses a malformed header name and a basic username containing a colon", () => {
    expect(parseBotSecretAuth({ type: "header", name: "bad header" })).toBeUndefined();
    expect(parseBotSecretAuth({ type: "header", name: "" })).toBeUndefined();
    expect(parseBotSecretAuth({ type: "basic", username: "a:b" })).toBeUndefined();
    expect(parseBotSecretAuth({ type: "basic", username: "" })).toBeUndefined();
    expect(parseBotSecretAuth({ type: "hmac" })).toBeUndefined();
    expect(parseBotSecretAuth(undefined)).toBeUndefined();
  });
});

describe("parsing a destination", () => {
  it("normalizes a trailing slash away and reports the rejected field by name", () => {
    expect(
      parseBotSecretDestination({
        name: "example_api",
        origin: "https://api.example.test/",
        auth: { type: "bearer" },
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "example_api",
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      },
    });

    expect(
      parseBotSecretDestination({
        name: "API",
        origin: "https://x.test",
        auth: { type: "bearer" },
      }),
    ).toEqual({ ok: false, reason: "invalid_name" });
    expect(
      parseBotSecretDestination({
        name: "api",
        origin: "http://x.test",
        auth: { type: "bearer" },
      }),
    ).toEqual({ ok: false, reason: "invalid_origin" });
    expect(
      parseBotSecretDestination({
        name: "api",
        origin: "https://x.test",
        auth: { type: "cookie" },
      }),
    ).toEqual({ ok: false, reason: "invalid_auth" });
  });

  it("never echoes a value-shaped field in a rejection", () => {
    const parsed = parseBotSecretDestination({
      name: "api",
      origin: "https://x.test",
      auth: { type: "header", name: "x-secret" },
      value: "sk-live-0123456789",
    });

    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("sk-live-0123456789");
  });
});

describe("the injected header", () => {
  const value = "sk-live-0123456789abcdef";

  it("builds a bearer header", () => {
    expect(
      botSecretCredentialHeader(
        { name: "api", origin: "https://x.test", auth: { type: "bearer" } },
        value,
      ),
    ).toEqual({ name: "authorization", value: `Bearer ${value}` });
  });

  it("builds a named header with the value unchanged", () => {
    expect(
      botSecretCredentialHeader(
        { name: "api", origin: "https://x.test", auth: { type: "header", name: "X-Api-Key" } },
        value,
      ),
    ).toEqual({ name: "X-Api-Key", value });
  });

  it("builds a basic header from the username and the value as the password", () => {
    const header = botSecretCredentialHeader(
      { name: "api", origin: "https://x.test", auth: { type: "basic", username: "api-user" } },
      value,
    );

    expect(header.name).toBe("authorization");
    expect(header.value).toBe(
      `Basic ${Buffer.from(`api-user:${value}`, "utf8").toString("base64")}`,
    );
  });
});
