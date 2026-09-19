import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The short-lived capability that names a run's credential-proxy grant (slice
 * 7.8, PRD decision 29; audit P1 item 7).
 *
 * A computer's proxy holds the run's upstream credentials and answers requests
 * from inside the sandbox. What the sandbox itself holds is this token — a
 * bearer capability with the same three properties the screen capability
 * (slice 7.1) established for the deferred takeover path:
 *
 *   - it is bound to one run *and* one computer — the run id, the computer id
 *     and the bot id are all signed into the token, and the proxy checks all
 *     three, so a token minted for one run is useless against another run's
 *     grant and a token for one machine is useless against another's proxy;
 *   - it expires, and the lifetime is bounded here rather than by the caller:
 *     the default covers one command's budget and the ceiling covers the
 *     supervisor's longest exec, so a token an agent manages to read out of
 *     its own environment stops working shortly after the command that
 *     carried it;
 *   - it is verified without a session store, because the signature is the
 *     proof — only a holder of the shared key can mint one, and the proxy is
 *     the only verifier.
 *
 * A token is a capability, not a credential: it cannot name an upstream, carry
 * a key, or open a grant that is not already written for its run. The grant's
 * own deadline — the run's lease end — is the second bound, and settling the
 * run removes the grant entirely, so an unexpired token is still useless once
 * its run ends.
 *
 * The comparison mirrors the screen capability's: constant-time, length-safe,
 * and a refusal is a typed reason — `malformed`, `forged`, `expired`,
 * `binding` — so the proxy answers 401 or 403 without logging the token,
 * which is itself a capability.
 */

/** The coordinates a proxy capability is bound to; all of them are verified. */
export interface ProxyCapabilityBinding {
  readonly runId: string;
  readonly computerId: string;
  readonly botId: string;
}

/**
 * What a verifier knows about the request's scope before it checks. The proxy
 * knows the computer it serves from its own configuration, so the binding
 * check compares all three coordinates against the token the request carried
 * and the grant the token names.
 */
export interface ProxyCapabilityExpectation {
  readonly runId?: string | undefined;
  readonly computerId?: string | undefined;
  readonly botId?: string | undefined;
}

/** Why a capability was refused. `binding` means a valid token for another scope. */
export type ProxyCapabilityRejection = "malformed" | "forged" | "expired" | "binding";

/** The verdict; a valid check returns the scope it proved and its deadline. */
export type ProxyCapabilityCheck =
  | {
      readonly valid: true;
      readonly binding: ProxyCapabilityBinding;
      readonly expiresAt: string;
    }
  | { readonly valid: false; readonly reason: ProxyCapabilityRejection };

export interface ProxyCapabilityCodec {
  /** Mints a token for the scope; `ttlSeconds` is clamped to the maximum, not trusted. */
  mint(binding: ProxyCapabilityBinding, ttlSeconds?: number): string;
  /** Verifies a token against the coordinates the caller can check. */
  verify(token: string, expected: ProxyCapabilityExpectation): ProxyCapabilityCheck;
}

/** Long enough to cover one command, short enough that a read-out token goes stale fast. */
export const DEFAULT_PROXY_CAPABILITY_TTL_SECONDS = 300;
/**
 * The ceiling a caller cannot raise: the supervisor's longest exec is ten
 * minutes, and a token that outlives the command carrying it buys an attacker
 * nothing the command could not already do.
 */
export const MAX_PROXY_CAPABILITY_TTL_SECONDS = 900;
/** Far longer than any token this codec mints; a cap keeps HMAC input bounded. */
export const MAX_PROXY_CAPABILITY_LENGTH = 1_024;

const CAPABILITY_VERSION = 1;

interface CapabilityPayload {
  readonly v: number;
  readonly r: string;
  readonly c: string;
  readonly b: string;
  /** Expiry, in whole Unix seconds. */
  readonly x: number;
}

export interface ProxyCapabilityCodecOptions {
  /** The current time in whole seconds; defaults to the wall clock. */
  readonly nowSeconds?: (() => number) | undefined;
}

function normalizeKey(secret: string | Uint8Array): Buffer {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);

  if (key.length === 0) {
    throw new Error("the proxy capability key must not be empty");
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
  const strings = ["r", "c", "b"] as const;

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
    r: record["r"] as string,
    c: record["c"] as string,
    b: record["b"] as string,
    x: record["x"] as number,
  };
}

/**
 * Builds the codec over one shared key. The key is the deployment's, not a
 * run's: minting happens where the run's work is composed, verification
 * happens inside the proxy, and the two agree through configuration —
 * `PORKBOT_PROXY_TOKEN_SECRET` on both processes. A deployment that does not
 * configure the key cannot mint and its proxies cannot verify, which is the
 * correct fail-closed posture.
 */
export function createProxyCapabilityCodec(
  secret: string | Uint8Array,
  options: ProxyCapabilityCodecOptions = {},
): ProxyCapabilityCodec {
  const key = normalizeKey(secret);
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));

  return {
    mint(binding: ProxyCapabilityBinding, ttlSeconds?: number): string {
      const requested = ttlSeconds ?? DEFAULT_PROXY_CAPABILITY_TTL_SECONDS;

      if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new RangeError(
          `the proxy capability lifetime must be a positive whole number of seconds, received ${String(ttlSeconds)}`,
        );
      }

      const ttl = Math.min(requested, MAX_PROXY_CAPABILITY_TTL_SECONDS);
      const payload = Buffer.from(
        JSON.stringify({
          v: CAPABILITY_VERSION,
          r: binding.runId,
          c: binding.computerId,
          b: binding.botId,
          x: nowSeconds() + ttl,
        } satisfies CapabilityPayload),
        "utf8",
      ).toString("base64url");

      return `${payload}.${signatureFor(key, payload)}`;
    },

    verify(token: string, expected: ProxyCapabilityExpectation): ProxyCapabilityCheck {
      if (token.length === 0 || token.length > MAX_PROXY_CAPABILITY_LENGTH) {
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
        (expected.runId !== undefined && decoded.r !== expected.runId) ||
        (expected.computerId !== undefined && decoded.c !== expected.computerId) ||
        (expected.botId !== undefined && decoded.b !== expected.botId)
      ) {
        return { valid: false, reason: "binding" };
      }

      if (nowSeconds() >= decoded.x) {
        return { valid: false, reason: "expired" };
      }

      return {
        valid: true,
        binding: { runId: decoded.r, computerId: decoded.c, botId: decoded.b },
        expiresAt: new Date(decoded.x * 1_000).toISOString(),
      };
    },
  };
}
