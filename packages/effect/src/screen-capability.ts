import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The short-lived capability that gates a computer's screen (slice 7.1, PRD
 * decision 20; story 28 deferred to v1.1).
 *
 * Screen watch and takeover are out of v1.0, but the access rule is not: when
 * the frames and input paths land, the browser cannot present a session cookie
 * to the supervisor, and the supervisor must not accept "the API asked" as
 * authorization. The answer this module ships now is a bearer capability with
 * three properties:
 *
 *   - it is bound to one computer *and* one actor — the computer id, the bot
 *     id, the space and the user are all signed into the token, and a verifier
 *     checks all four, so a token for one machine is useless against another
 *     and a member of one space cannot present a colleague's;
 *   - it expires, and the lifetime is bounded here rather than by the caller:
 *     a minute by default, never more than five, so a leaked frame URL stops
 *     working before it can be traded;
 *   - it is verified without a session store, because the signature is the
 *     proof — only a holder of the shared key can mint one, and only this
 *     deployment's supervisor is meant to verify.
 *
 * The key is required, not defaulted: a random per-process key would make a
 * token minted by the API unverifiable by the supervisor, and the failure
 * mode would look like an expiry rather than a misconfiguration. A deployment
 * that does not configure the key refuses screen access entirely, which is the
 * correct v1.0 posture.
 *
 * The comparison mirrors the webhook signature's: constant-time, length-safe,
 * and bounded, and a refusal is a typed reason — `malformed`, `forged`,
 * `expired`, `binding` — so the supervisor answers 401 or 403 without logging
 * the token, which is itself a capability.
 */

/** The four coordinates a capability is bound to; all four are verified. */
export interface ScreenCapabilityBinding {
  readonly computerId: string;
  readonly botId: string;
  readonly spaceId: string;
  readonly userId: string;
}

/**
 * What a verifier knows about the request's scope before it checks. A verifier
 * checks exactly the coordinates it supplies: the supervisor knows the
 * computer from the route, while the actor and the space are proven by the
 * signature itself and are read back from the token, so the supervisor does
 * not need a session store to hold the actor boundary.
 */
export interface ScreenCapabilityExpectation {
  readonly computerId?: string | undefined;
  readonly botId?: string | undefined;
  readonly spaceId?: string | undefined;
  readonly userId?: string | undefined;
}

/** Why a capability was refused. `binding` means a valid token for another scope. */
export type ScreenCapabilityRejection = "malformed" | "forged" | "expired" | "binding";

/** The verdict; a valid check returns the scope it proved and its deadline. */
export type ScreenCapabilityCheck =
  | {
      readonly valid: true;
      readonly binding: ScreenCapabilityBinding;
      readonly expiresAt: string;
    }
  | { readonly valid: false; readonly reason: ScreenCapabilityRejection };

export interface ScreenCapabilityCodec {
  /** Mints a token for the scope; `ttlSeconds` is clamped to the maximum, not trusted. */
  mint(binding: ScreenCapabilityBinding, ttlSeconds?: number): string;
  /** Verifies a token against the coordinates the caller can check. */
  verify(token: string, expected: ScreenCapabilityExpectation): ScreenCapabilityCheck;
}

/** Long enough to open a screen, short enough that a leaked URL goes stale. */
export const DEFAULT_SCREEN_CAPABILITY_TTL_SECONDS = 60;
/** The ceiling a caller cannot raise: five minutes. */
export const MAX_SCREEN_CAPABILITY_TTL_SECONDS = 300;
/** Far longer than any token this codec mints; a cap keeps HMAC input bounded. */
export const MAX_SCREEN_CAPABILITY_LENGTH = 1_024;

const CAPABILITY_VERSION = 1;

interface CapabilityPayload {
  readonly v: number;
  readonly c: string;
  readonly b: string;
  readonly s: string;
  readonly u: string;
  /** Expiry, in whole Unix seconds. */
  readonly x: number;
}

export interface ScreenCapabilityCodecOptions {
  /** The current time in whole seconds; defaults to the wall clock. */
  readonly nowSeconds?: (() => number) | undefined;
}

function normalizeKey(secret: string | Uint8Array): Buffer {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);

  if (key.length === 0) {
    throw new Error("the screen capability key must not be empty");
  }

  return key;
}

function signatureFor(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function signatureMatches(key: Buffer, payload: string, signature: string): boolean {
  const expected = Buffer.from(signatureFor(key, payload), "base64url");
  const received = Buffer.from(signature, "base64url");

  return expected.length === received.length && timingSafeEqual(expected, received);
}

function decodePayload(payload: string): CapabilityPayload | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const strings = ["c", "b", "s", "u"] as const;

  for (const field of strings) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      return undefined;
    }
  }

  if (
    record["v"] !== CAPABILITY_VERSION ||
    !Number.isSafeInteger(record["x"]) ||
    (record["x"] as number) <= 0
  ) {
    return undefined;
  }

  return {
    v: CAPABILITY_VERSION,
    c: record["c"] as string,
    b: record["b"] as string,
    s: record["s"] as string,
    u: record["u"] as string,
    x: record["x"] as number,
  };
}

/**
 * Builds the codec over one shared key. The key is the deployment's, not a
 * user's: minting is an authorization decision the caller has already made.
 */
export function createScreenCapabilityCodec(
  secret: string | Uint8Array,
  options: ScreenCapabilityCodecOptions = {},
): ScreenCapabilityCodec {
  const key = normalizeKey(secret);
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));

  return {
    mint(binding: ScreenCapabilityBinding, ttlSeconds?: number): string {
      const requested = ttlSeconds ?? DEFAULT_SCREEN_CAPABILITY_TTL_SECONDS;

      if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new RangeError(
          `the screen capability lifetime must be a positive whole number of seconds, received ${String(ttlSeconds)}`,
        );
      }

      const ttl = Math.min(requested, MAX_SCREEN_CAPABILITY_TTL_SECONDS);
      const payload = Buffer.from(
        JSON.stringify({
          v: CAPABILITY_VERSION,
          c: binding.computerId,
          b: binding.botId,
          s: binding.spaceId,
          u: binding.userId,
          x: nowSeconds() + ttl,
        } satisfies CapabilityPayload),
        "utf8",
      ).toString("base64url");

      return `${payload}.${signatureFor(key, payload)}`;
    },

    verify(token: string, expected: ScreenCapabilityExpectation): ScreenCapabilityCheck {
      if (token.length === 0 || token.length > MAX_SCREEN_CAPABILITY_LENGTH) {
        return { valid: false, reason: "malformed" };
      }

      const separator = token.indexOf(".");

      if (separator <= 0 || separator === token.length - 1) {
        return { valid: false, reason: "malformed" };
      }

      const payload = token.slice(0, separator);
      const signature = token.slice(separator + 1);

      if (!signatureMatches(key, payload, signature)) {
        return { valid: false, reason: "forged" };
      }

      const decoded = decodePayload(payload);

      if (decoded === undefined) {
        return { valid: false, reason: "malformed" };
      }

      if (
        (expected.computerId !== undefined && decoded.c !== expected.computerId) ||
        (expected.botId !== undefined && decoded.b !== expected.botId) ||
        (expected.spaceId !== undefined && decoded.s !== expected.spaceId) ||
        (expected.userId !== undefined && decoded.u !== expected.userId)
      ) {
        return { valid: false, reason: "binding" };
      }

      if (nowSeconds() >= decoded.x) {
        return { valid: false, reason: "expired" };
      }

      return {
        valid: true,
        binding: {
          computerId: decoded.c,
          botId: decoded.b,
          spaceId: decoded.s,
          userId: decoded.u,
        },
        expiresAt: new Date(decoded.x * 1_000).toISOString(),
      };
    },
  };
}
