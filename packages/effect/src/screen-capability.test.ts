import { describe, expect, it } from "vitest";
import {
  createScreenCapabilityCodec,
  DEFAULT_SCREEN_CAPABILITY_TTL_SECONDS,
  MAX_SCREEN_CAPABILITY_LENGTH,
  MAX_SCREEN_CAPABILITY_TTL_SECONDS,
} from "./screen-capability.ts";
import type { ScreenCapabilityBinding } from "./screen-capability.ts";

/**
 * The screen capability's rules. What this suite proves is the access boundary
 * the acceptance criteria name: a token is good for exactly one computer and
 * exactly one actor, it stops working on its deadline, and a token minted for
 * one scope cannot be edited into another. The clock is injected, so expiry is
 * asserted on both sides of a deadline instead of by sleeping.
 */

const binding: ScreenCapabilityBinding = {
  computerId: "computer-1",
  botId: "bot-1",
  spaceId: "space-1",
  userId: "user-1",
};

function codecAt(seconds: number, key = "screen-key") {
  return createScreenCapabilityCodec(key, { nowSeconds: () => seconds });
}

describe("the screen capability codec", () => {
  it("mints a token its own key and scope accept", () => {
    const codec = codecAt(1_000);
    const token = codec.mint(binding);

    expect(token).not.toContain(binding.computerId);
    expect(codec.verify(token, binding)).toEqual({
      valid: true,
      binding,
      expiresAt: "1970-01-01T00:17:40.000Z",
    });
  });

  it("defaults to a minute and refuses to exceed the ceiling", () => {
    const mintedAt = 1_000;
    const codec = codecAt(mintedAt);

    const defaulted = codec.verify(codec.mint(binding), binding);
    const ceiling = codec.verify(codec.mint(binding, 60 * 60), binding);

    expect(defaulted).toMatchObject({
      expiresAt: new Date((mintedAt + DEFAULT_SCREEN_CAPABILITY_TTL_SECONDS) * 1_000).toISOString(),
    });
    expect(ceiling).toMatchObject({
      expiresAt: new Date((mintedAt + MAX_SCREEN_CAPABILITY_TTL_SECONDS) * 1_000).toISOString(),
    });
  });

  it("refuses a lifetime that is not a positive whole number of seconds", () => {
    const codec = codecAt(1_000);

    expect(() => codec.mint(binding, 0)).toThrow(RangeError);
    expect(() => codec.mint(binding, -1)).toThrow(RangeError);
    expect(() => codec.mint(binding, 1.5)).toThrow(RangeError);
  });

  it("stops accepting a token on its deadline", () => {
    const codec = codecAt(2_000);
    const token = codec.mint(binding, 30);

    expect(codecAt(2_029).verify(token, binding).valid).toBe(true);
    expect(codecAt(2_030).verify(token, binding)).toEqual({ valid: false, reason: "expired" });
  });

  it("is bound to the computer, the bot, the space and the actor, one at a time", () => {
    const token = codecAt(3_000).mint(binding);
    const codec = codecAt(3_000);
    const others: ScreenCapabilityBinding[] = [
      { ...binding, computerId: "computer-2" },
      { ...binding, botId: "bot-2" },
      { ...binding, spaceId: "space-2" },
      { ...binding, userId: "user-2" },
    ];

    for (const other of others) {
      expect(codec.verify(token, other), JSON.stringify(other)).toEqual({
        valid: false,
        reason: "binding",
      });
    }
  });

  it("refuses a token minted under another key", () => {
    const token = codecAt(4_000, "key-a").mint(binding);

    expect(codecAt(4_000, "key-b").verify(token, binding)).toEqual({
      valid: false,
      reason: "forged",
    });
  });

  it("refuses an edited payload rather than reading its claims", () => {
    const codec = codecAt(5_000);
    const token = codec.mint(binding);
    const [payload = "", signature = ""] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    decoded["u"] = "user-2";
    const edited = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

    expect(codec.verify(`${edited}.${signature}`, binding)).toEqual({
      valid: false,
      reason: "forged",
    });
  });

  it("refuses malformed values without throwing", () => {
    const codec = codecAt(6_000);
    const token = codec.mint(binding);
    const [payload = "", signature = ""] = token.split(".");

    for (const malformed of [
      "",
      ".",
      "no-signature.",
      ".no-payload",
      token.replace(".", ""),
      `${payload}.${signature}.extra`,
      `${"a".repeat(MAX_SCREEN_CAPABILITY_LENGTH + 1)}.${signature}`,
      `${Buffer.from("not json", "utf8").toString("base64url")}.${signature}`,
      `${Buffer.from(JSON.stringify({ v: 1, c: "computer-1" }), "utf8").toString("base64url")}.${signature}`,
    ]) {
      const verdict = codec.verify(malformed, binding);

      expect(verdict.valid, malformed.slice(0, 24)).toBe(false);
      expect(verdict).toMatchObject({ reason: expect.stringMatching(/malformed|forged/) });
    }
  });

  it("refuses to exist without a key, so an unconfigured deployment fails closed", () => {
    expect(() => createScreenCapabilityCodec("")).toThrow(Error);
    expect(() => createScreenCapabilityCodec(new Uint8Array())).toThrow(Error);
  });
});
