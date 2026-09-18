import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The one way an inbound webhook proves where it came from (PRD decision 24).
 *
 * A provider signs the bytes it sends; the receiver checks that signature over
 * the raw body *before* anything parses it, so an unsigned or wrongly-signed
 * request has no path into a handler, a JSON parser or a database. The scheme
 * is deliberately generic — any provider adapter, forwarding proxy or offline
 * emulator can produce it with `signWebhookBody` — and it is:
 *
 *   - `x-porkbot-delivery` carries the provider's delivery id, which the
 *     ingress dedupes on.
 *   - `x-porkbot-signature` carries `t=<unix seconds>,v1=<hex>`, where the
 *     digest is HMAC-SHA256 over `<t>.<raw body bytes>`.
 *   - A signature outside the freshness window is refused even when the digest
 *     is correct, so a captured request cannot be replayed later.
 *   - The digest comparison is constant-time and never throws on a signature
 *     of another length.
 *
 * The functions here are pure apart from the HMAC and a `Date.now()` default;
 * `nowSeconds` is injectable so a test can place a request on either side of
 * the window instead of sleeping through it.
 */

/** The header carrying the provider's delivery id; the ingress dedupes on it. */
export const webhookDeliveryHeader = "x-porkbot-delivery";

/** The header carrying `t=<unix seconds>,v1=<hex hmac>` over `<t>.<body>`. */
export const webhookSignatureHeader = "x-porkbot-signature";

/**
 * How far outside the signature's timestamp a request may be, in seconds.
 * Five minutes is the PRD's window: long enough for a provider's retry and for
 * clock drift between hosts, short enough that a captured request is worthless
 * by the time an attacker replays it.
 */
export const defaultSignatureToleranceSeconds = 300;

/**
 * The largest digest this module will decode, in hex characters: 64 bytes,
 * twice SHA-256's 32-byte width. The bound keeps a hostile header from turning
 * the comparison into an unbounded loop; a longer value is malformed, not a
 * longer secret.
 */
const maxDigestHexLength = 128;

/** A parsed signature header: the timestamp that was signed and the digest. */
export interface ParsedWebhookSignature {
  readonly timestampSeconds: number;
  readonly digest: Uint8Array;
}

/** Why a signature was refused; the ingress logs it and answers 401. */
export type WebhookSignatureFailure = "missing" | "malformed" | "stale" | "future" | "mismatch";

/** The verdict. A valid check returns the signed timestamp for logging. */
export type WebhookSignatureCheck =
  | { readonly valid: true; readonly timestampSeconds: number }
  | { readonly valid: false; readonly reason: WebhookSignatureFailure };

export interface SignWebhookInput {
  readonly timestampSeconds: number;
  readonly body: string | Uint8Array;
}

/**
 * Produces the header value a sender puts in `x-porkbot-signature`. It is the
 * inverse of `verifyWebhookSignature` by construction — same payload, same key,
 * same encoding — so it is what the test suite signs with and what an adapter
 * or emulator that emits webhooks will sign with.
 */
export function signWebhookBody(secret: string, input: SignWebhookInput): string {
  const digest = createHmac("sha256", secret)
    .update(`${input.timestampSeconds}.`)
    .update(input.body)
    .digest("hex");

  return `t=${input.timestampSeconds},v1=${digest}`;
}

/**
 * Parses `t=<seconds>,v1=<hex>` without trusting any part of it: an unknown
 * part is ignored (forward compatibility with a future `v2`), and a duplicate,
 * non-numeric or over-long part makes the whole header malformed rather than
 * letting the last value win.
 */
export function parseWebhookSignature(
  header: string | undefined,
): ParsedWebhookSignature | undefined {
  if (header === undefined) {
    return undefined;
  }

  let timestampSeconds: number | undefined;
  let digest: Uint8Array | undefined;

  for (const rawPart of header.split(",")) {
    const separator = rawPart.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const name = rawPart.slice(0, separator).trim();
    const value = rawPart.slice(separator + 1).trim();

    if (name === "t") {
      if (timestampSeconds !== undefined || !/^\d{1,12}$/.test(value)) {
        return undefined;
      }

      timestampSeconds = Number(value);
      continue;
    }

    if (name === "v1") {
      if (
        digest !== undefined ||
        value.length === 0 ||
        value.length % 2 !== 0 ||
        value.length > maxDigestHexLength ||
        !/^[0-9a-fA-F]+$/.test(value)
      ) {
        return undefined;
      }

      digest = Uint8Array.from(Buffer.from(value, "hex"));
    }
  }

  if (timestampSeconds === undefined || digest === undefined) {
    return undefined;
  }

  return { timestampSeconds, digest };
}

export interface VerifyWebhookSignatureInput {
  readonly secret: string;
  readonly signature: string | undefined;
  /**
   * The exact bytes the sender signed: the raw body, before parsing. A caller
   * that decodes or re-encodes the body first has changed what it is verifying.
   */
  readonly body: string | Uint8Array;
  /** The current time in whole seconds; defaults to the wall clock. */
  readonly nowSeconds?: number;
  readonly toleranceSeconds?: number;
}

/**
 * The verdict for one request. Order matters for the property this module
 * exists to provide: the header is parsed and the freshness window and digest
 * are checked before the caller is ever handed a body to parse. A missing
 * header and a header that cannot be parsed are distinct reasons so an operator
 * can tell a misconfigured sender from an attacker probing the endpoint.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): WebhookSignatureCheck {
  const parsed = parseWebhookSignature(input.signature);

  if (parsed === undefined) {
    return { valid: false, reason: input.signature === undefined ? "missing" : "malformed" };
  }

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const toleranceSeconds = input.toleranceSeconds ?? defaultSignatureToleranceSeconds;

  if (nowSeconds - parsed.timestampSeconds > toleranceSeconds) {
    return { valid: false, reason: "stale" };
  }

  if (parsed.timestampSeconds - nowSeconds > toleranceSeconds) {
    return { valid: false, reason: "future" };
  }

  const expected = createHmac("sha256", input.secret)
    .update(`${parsed.timestampSeconds}.`)
    .update(input.body)
    .digest();

  if (!timingSafeEqualBytes(parsed.digest, expected)) {
    return { valid: false, reason: "mismatch" };
  }

  return { valid: true, timestampSeconds: parsed.timestampSeconds };
}

/**
 * Compares two byte strings without an early exit on their contents. Node's
 * `timingSafeEqual` throws a `RangeError` when the lengths differ — the crash
 * this helper exists to prevent — so a length mismatch is answered `false`
 * first. That check leaks only the expected digest's width, which is public
 * (HMAC-SHA256 is 32 bytes); the secret-derived bytes themselves are compared
 * by the native constant-time primitive.
 */
export function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}
