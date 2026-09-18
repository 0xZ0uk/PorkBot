import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CursorRejectedError } from "@porkbot/effect";

/**
 * The resumable-cursor codec (slice 4.3, PRD decision 18).
 *
 * A cursor is an SSE event id a client presents on reconnect. It is
 * HMAC-signed and its payload names the actor, the space, the thread and the
 * position, so the server can decide two different things without a session
 * table of its own: whether the value was minted here, and whether the same
 * actor, space and thread are asking for it. A guessed event id therefore
 * cannot replay another space's stream, and a cursor that outlived its tenant
 * context is refused with a typed `BAD_REQUEST` rather than silently replayed
 * from zero.
 *
 * The key is process-local unless one is injected: a cursor only has to
 * outlive the connection that produced it, so a restart invalidating every
 * cursor costs a reconnect from zero, not data. The signature is compared with
 * `timingSafeEqual`, and a cursor is never logged — it encodes tenant ids.
 */

/** The scope a cursor is bound to; a cursor from any other scope is refused. */
export interface CursorBinding {
  readonly spaceId: string;
  readonly threadId: string;
  readonly userId: string;
}

/** A binding plus the position in the thread's event stream. */
export interface CursorPosition extends CursorBinding {
  readonly seq: number;
}

export interface CursorCodec {
  /** Mints the opaque id for one delivered event. */
  sign(position: CursorPosition): string;
  /**
   * Returns the position a cursor names, or throws `CursorRejectedError` when
   * it is malformed, forged, or bound to another actor, space or thread.
   */
  verify(cursor: string, binding: CursorBinding): number;
}

const CURSOR_VERSION = 1;
const SIGNATURE_BYTES = 32;
/** Far longer than any cursor this codec mints; a cap keeps HMAC input bounded. */
const MAX_CURSOR_LENGTH = 512;

interface CursorPayload {
  readonly v: number;
  readonly s: string;
  readonly t: string;
  readonly u: string;
  readonly q: number;
}

export function createCursorCodec(secret?: string | Uint8Array): CursorCodec {
  const key = normalizeSecret(secret);

  return {
    sign(position: CursorPosition): string {
      const payload = Buffer.from(
        JSON.stringify({
          v: CURSOR_VERSION,
          s: position.spaceId,
          t: position.threadId,
          u: position.userId,
          q: position.seq,
        }),
        "utf8",
      ).toString("base64url");

      return `${payload}.${signatureFor(key, payload)}`;
    },

    verify(cursor: string, binding: CursorBinding): number {
      if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
        throw new CursorRejectedError("malformed");
      }

      const parts = cursor.split(".");

      if (parts.length !== 2) {
        throw new CursorRejectedError("malformed");
      }

      const [payload = "", signature = ""] = parts;

      if (
        payload.length === 0 ||
        signature.length === 0 ||
        !signatureMatches(key, payload, signature)
      ) {
        throw new CursorRejectedError("forged");
      }

      const decoded = decodePayload(payload);

      if (
        decoded.s !== binding.spaceId ||
        decoded.t !== binding.threadId ||
        decoded.u !== binding.userId
      ) {
        throw new CursorRejectedError("binding");
      }

      return decoded.q;
    },
  };
}

function normalizeSecret(secret: string | Uint8Array | undefined): Buffer {
  if (secret === undefined) {
    return randomBytes(SIGNATURE_BYTES);
  }

  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);

  if (key.length === 0) {
    throw new Error("the cursor signing key must not be empty");
  }

  return key;
}

function signatureFor(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function signatureMatches(key: Buffer, payload: string, signature: string): boolean {
  const expected = createHmac("sha256", key).update(payload).digest();
  const received = Buffer.from(signature, "base64url");

  return received.length === expected.length && timingSafeEqual(expected, received);
}

function decodePayload(payload: string): CursorPayload {
  let value: unknown;

  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new CursorRejectedError("malformed");
  }

  if (typeof value !== "object" || value === null) {
    throw new CursorRejectedError("malformed");
  }

  const record = value as Record<string, unknown>;

  if (
    record["v"] !== CURSOR_VERSION ||
    typeof record["s"] !== "string" ||
    typeof record["t"] !== "string" ||
    typeof record["u"] !== "string" ||
    typeof record["q"] !== "number" ||
    !Number.isSafeInteger(record["q"]) ||
    record["q"] < 0
  ) {
    throw new CursorRejectedError("malformed");
  }

  return {
    v: CURSOR_VERSION,
    s: record["s"],
    t: record["t"],
    u: record["u"],
    q: record["q"],
  };
}
