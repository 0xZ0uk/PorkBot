import { describe, expect, it } from "vitest";
import {
  defaultSignatureToleranceSeconds,
  parseWebhookSignature,
  signWebhookBody,
  timingSafeEqualBytes,
  verifyWebhookSignature,
} from "./webhook-signature.ts";

/**
 * The signature module's suite: what the ingress relies on is checked here.
 *
 * The property this slice exists for — verification happens before parsing —
 * is enforced by the caller and proven against the HTTP surface; this suite
 * proves the primitive itself: a correct signature is accepted, a missing,
 * malformed, stale, future or mismatched one is refused with a distinct reason,
 * and a digest of any length is answered `false` instead of throwing.
 */

const secret = "test-secret-not-a-real-credential";
const body = JSON.stringify({ event: "ping", delivery: 1 });

describe("signing and verifying", () => {
  it("accepts a signature it produced, over a string or a byte body", () => {
    const signature = signWebhookBody(secret, { timestampSeconds: 1_700_000_000, body });

    expect(
      verifyWebhookSignature({
        secret,
        signature,
        body,
        nowSeconds: 1_700_000_010,
      }),
    ).toEqual({ valid: true, timestampSeconds: 1_700_000_000 });

    const bytes = new TextEncoder().encode(body);
    const overBytes = signWebhookBody(secret, { timestampSeconds: 1_700_000_000, body: bytes });

    expect(overBytes).toBe(signature);
    expect(
      verifyWebhookSignature({
        secret,
        signature: overBytes,
        body: bytes,
        nowSeconds: 1_700_000_010,
      }).valid,
    ).toBe(true);
  });

  it("ignores a scheme part it does not know, so a future v2 does not break a v1 sender", () => {
    const signature = signWebhookBody(secret, { timestampSeconds: 1_700_000_000, body });
    const withUnknown = signature.replace("v1=", "v2=whatever,v1=");

    expect(
      verifyWebhookSignature({ secret, signature: withUnknown, body, nowSeconds: 1_700_000_000 })
        .valid,
    ).toBe(true);
  });

  it("verifies bytes that are not valid UTF-8, because it signs the bytes they are", () => {
    // A caller that decoded the body to a string first would replace these
    // bytes and never verify a sender that signed the raw payload.
    const binary = new Uint8Array([0x80, 0xff, 0x00, 0x41, 0xfe]);
    const signature = signWebhookBody(secret, { timestampSeconds: 1_700_000_000, body: binary });

    expect(
      verifyWebhookSignature({
        secret,
        signature,
        body: binary,
        nowSeconds: 1_700_000_000,
      }).valid,
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        secret,
        signature,
        body: new TextDecoder().decode(binary),
        nowSeconds: 1_700_000_000,
      }).valid,
    ).toBe(false);
  });
});

describe("the reasons a signature is refused", () => {
  const nowSeconds = 1_700_000_000;

  it("reports a missing header as missing", () => {
    expect(verifyWebhookSignature({ secret, signature: undefined, body, nowSeconds })).toEqual({
      valid: false,
      reason: "missing",
    });
  });

  it("reports a header that cannot be parsed as malformed, never as a mismatch", () => {
    const malformed = [
      "",
      "not-a-signature",
      "t=,v1=00",
      "t=abc,v1=00",
      "t=1700000000",
      "v1=00",
      "t=1700000000,v1=",
      "t=1700000000,v1=0",
      "t=1700000000,v1=zz",
      "t=1700000000,v1=00,v1=00",
      "t=1700000000,t=1700000000",
      `t=1700000000,v1=${"ab".repeat(65)}`,
    ];

    for (const signature of malformed) {
      expect(
        verifyWebhookSignature({ secret, signature, body, nowSeconds }),
        `"${signature}" must be malformed`,
      ).toEqual({ valid: false, reason: "malformed" });
    }
  });

  it("rejects a signature older than the window and keeps the boundary inclusive", () => {
    const signature = signWebhookBody(secret, {
      timestampSeconds: nowSeconds - defaultSignatureToleranceSeconds,
      body,
    });

    expect(
      verifyWebhookSignature({ secret, signature, body, nowSeconds }).valid,
      "a signature exactly at the window's edge is still fresh",
    ).toBe(true);

    const justOutside = signWebhookBody(secret, { timestampSeconds: nowSeconds - 301, body });

    expect(verifyWebhookSignature({ secret, signature: justOutside, body, nowSeconds })).toEqual({
      valid: false,
      reason: "stale",
    });
  });

  it("rejects a far-future timestamp instead of accepting it forever", () => {
    const signature = signWebhookBody(secret, { timestampSeconds: nowSeconds + 301, body });

    expect(verifyWebhookSignature({ secret, signature, body, nowSeconds })).toEqual({
      valid: false,
      reason: "future",
    });
  });

  it("rejects a digest that was computed over other bytes, another timestamp or another secret", () => {
    const signature = signWebhookBody(secret, { timestampSeconds: nowSeconds, body });
    // A header whose timestamp was swapped while the digest stayed behind: the
    // digest is still well-formed, and must fail on the bytes, not the parser.
    const tamperedTimestamp = signature.replace(`t=${nowSeconds}`, `t=${nowSeconds + 1}`);

    expect(verifyWebhookSignature({ secret, signature, body: `${body} `, nowSeconds })).toEqual({
      valid: false,
      reason: "mismatch",
    });
    expect(
      verifyWebhookSignature({ secret, signature: tamperedTimestamp, body, nowSeconds }),
    ).toEqual({ valid: false, reason: "mismatch" });
    expect(
      verifyWebhookSignature({ secret: "another-secret", signature, body, nowSeconds }),
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  it("tolerates a digest of another length without throwing", () => {
    // Lengths on both sides of the real 32-byte digest. The point is that this
    // never throws the RangeError `timingSafeEqual` raises on unequal lengths.
    const lengths = [1, 31, 33, 64];

    for (const length of lengths) {
      const digest = "ab".repeat(length);
      const signature = `t=${nowSeconds},v1=${digest}`;
      const verdict = verifyWebhookSignature({ secret, signature, body, nowSeconds });

      expect(verdict, `a ${length}-byte digest must be a mismatch`).toEqual({
        valid: false,
        reason: "mismatch",
      });
    }
  });

  it("honours a caller-supplied tolerance instead of the default", () => {
    const signature = signWebhookBody(secret, { timestampSeconds: nowSeconds - 60, body });

    expect(verifyWebhookSignature({ secret, signature, body, nowSeconds }).valid).toBe(true);
    expect(
      verifyWebhookSignature({ secret, signature, body, nowSeconds, toleranceSeconds: 30 }),
    ).toEqual({ valid: false, reason: "stale" });
  });
});

describe("parsing the header", () => {
  it("returns the timestamp and the decoded digest, and undefined otherwise", () => {
    const parsed = parseWebhookSignature("t=1700000000,v1=0001fe");

    expect(parsed?.timestampSeconds).toBe(1_700_000_000);
    expect(parsed?.digest).toEqual(Uint8Array.from([0, 1, 254]));
    expect(parseWebhookSignature(undefined)).toBeUndefined();
    expect(parseWebhookSignature("t=1700000000")).toBeUndefined();
  });
});

describe("the constant-time byte comparison", () => {
  it("answers true only for byte-for-byte equal inputs", () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(new Uint8Array([]), new Uint8Array([]))).toBe(true);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([9, 2, 3]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 9]))).toBe(false);
  });

  it("answers false for different lengths instead of throwing", () => {
    const full = new Uint8Array([1, 2, 3, 4]);

    expect(timingSafeEqualBytes(new Uint8Array([]), full)).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), full)).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3, 4, 5]), full)).toBe(false);
  });
});
