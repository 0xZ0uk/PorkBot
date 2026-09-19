import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createProxyCapabilityCodec,
  DEFAULT_PROXY_CAPABILITY_TTL_SECONDS,
  MAX_PROXY_CAPABILITY_TTL_SECONDS,
} from "./proxy-capability.ts";

/**
 * The credential-proxy capability contract (slice 7.8, PRD decision 29).
 *
 * The codec is exercised here the same way the proxy exercises it: mint for a
 * scope, verify against the scope the proxy knows from configuration, and
 * prove that a forged, malformed, foreign or expired token is a typed refusal
 * and never an accident of comparison.
 */

const SECRET = "test-proxy-capability-key";
const RUN = "run-123";
const COMPUTER = "computer-abc";
const BOT = "bot-xyz";

const binding = { runId: RUN, computerId: COMPUTER, botId: BOT };

describe("the proxy capability codec", () => {
  it("mints a token its own verifier accepts", () => {
    const codec = createProxyCapabilityCodec(SECRET);
    const token = codec.mint(binding);
    const check = codec.verify(token, binding);

    expect(check.valid).toBe(true);
    if (check.valid) {
      expect(check.binding).toEqual(binding);
      expect(Date.parse(check.expiresAt)).toBeGreaterThan(Date.now());
    }
  });

  it("refuses a token minted under a different key as forged", () => {
    const foreign = createProxyCapabilityCodec("a-different-key").mint(binding);
    const check = createProxyCapabilityCodec(SECRET).verify(foreign, binding);

    expect(check).toEqual({ valid: false, reason: "forged" });
  });

  it("refuses a token whose signature was altered, including on its scope", () => {
    const codec = createProxyCapabilityCodec(SECRET);
    const token = codec.mint(binding);
    const [payload = ""] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;

    const tampered = `${Buffer.from(JSON.stringify({ ...decoded, r: "run-other" }), "utf8").toString("base64url")}.${token.slice(token.indexOf(".") + 1)}`;

    expect(codec.verify(tampered, binding)).toEqual({ valid: false, reason: "forged" });
  });

  it("refuses malformed tokens: empty, oversized, unsigned, undecodable", () => {
    const codec = createProxyCapabilityCodec(SECRET);

    expect(codec.verify("", binding)).toEqual({ valid: false, reason: "malformed" });
    expect(codec.verify("x".repeat(1_025), binding)).toEqual({
      valid: false,
      reason: "malformed",
    });
    expect(codec.verify("no-signature", binding)).toEqual({
      valid: false,
      reason: "malformed",
    });
    expect(codec.verify("ends-with-dot.", binding)).toEqual({
      valid: false,
      reason: "malformed",
    });

    const unsigned = `${Buffer.from(JSON.stringify({ v: 1, r: RUN, c: COMPUTER, b: BOT, x: 9_999_999_999 }), "utf8").toString("base64url")}.AAAA`;
    expect(codec.verify(unsigned, binding)).toEqual({ valid: false, reason: "forged" });

    const garbagePayload = Buffer.from("not json", "utf8").toString("base64url");
    const signedGarbage = `${garbagePayload}.${createHmac("sha256", SECRET).update(garbagePayload).digest("base64url")}`;
    expect(codec.verify(signedGarbage, binding)).toEqual({ valid: false, reason: "malformed" });
  });

  it("refuses a token bound to a different run, computer or bot", () => {
    const codec = createProxyCapabilityCodec(SECRET);
    const token = codec.mint(binding);

    expect(codec.verify(token, { runId: "run-other" })).toEqual({
      valid: false,
      reason: "binding",
    });
    expect(codec.verify(token, { computerId: "computer-other" })).toEqual({
      valid: false,
      reason: "binding",
    });
    expect(codec.verify(token, { botId: "bot-other" })).toEqual({
      valid: false,
      reason: "binding",
    });
    expect(codec.verify(token, { runId: RUN, computerId: "computer-other" })).toEqual({
      valid: false,
      reason: "binding",
    });
  });

  it("refuses an expired token even when the scope matches", () => {
    let now = 1_800_000_000;
    const codec = createProxyCapabilityCodec(SECRET, { nowSeconds: () => now });
    const token = codec.mint(binding, 60);

    expect(codec.verify(token, binding).valid).toBe(true);

    now += 61;
    expect(codec.verify(token, binding)).toEqual({ valid: false, reason: "expired" });
  });

  it("caps a requested lifetime at the maximum rather than trusting the caller", () => {
    let now = 1_800_000_000;
    const codec = createProxyCapabilityCodec(SECRET, { nowSeconds: () => now });
    const token = codec.mint(binding, MAX_PROXY_CAPABILITY_TTL_SECONDS * 10);

    now += MAX_PROXY_CAPABILITY_TTL_SECONDS + 1;
    expect(codec.verify(token, binding)).toEqual({ valid: false, reason: "expired" });
  });

  it("uses the default lifetime when none is given", () => {
    let now = 1_800_000_000;
    const codec = createProxyCapabilityCodec(SECRET, { nowSeconds: () => now });
    const token = codec.mint(binding);

    now += DEFAULT_PROXY_CAPABILITY_TTL_SECONDS + 1;
    expect(codec.verify(token, binding)).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a non-positive or non-integer lifetime", () => {
    const codec = createProxyCapabilityCodec(SECRET);

    expect(() => codec.mint(binding, 0)).toThrow(RangeError);
    expect(() => codec.mint(binding, -5)).toThrow(RangeError);
    expect(() => codec.mint(binding, 1.5)).toThrow(RangeError);
  });

  it("rejects an empty key at construction", () => {
    expect(() => createProxyCapabilityCodec("")).toThrow(/must not be empty/);
  });
});
