/**
 * Bot secrets (slice 9.6, E9 epic; reference parity BotSecret and the
 * `request_secret` / `list_secrets` / `forget_secret` tool family).
 *
 * A bot secret is a named credential an operator stores for one bot: a value,
 * the one HTTPS origin it may be sent to, and how it authenticates. The tool
 * layer only ever moves the destination — never the value — so this module is
 * the whole vocabulary a request, a header and a durable row are written from:
 * the name shape, the origin shape, the three authentication modes, and the one
 * function that turns a destination plus a value into the request header the
 * run's credential proxy injects.
 *
 * The value never becomes part of this module's output except through
 * `botSecretCredentialHeader`, which is called server-side at the proxy
 * boundary. Nothing here logs, stores or echoes a value.
 */

/** The name a bot secret is requested, listed and addressed by. */
export const BOT_SECRET_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_BOT_SECRET_NAME_LENGTH = 64;
/** The reference implementation's bound, large enough for a long key. */
export const MAX_BOT_SECRET_VALUE_LENGTH = 16_384;
/** The longest username a basic credential may carry. */
export const MAX_BOT_SECRET_USERNAME_LENGTH = 200;

/** Whether a request raised a value decision the operator can still make. */
export const BOT_SECRET_STATUSES = ["stored", "forgotten"] as const;
export type BotSecretStatus = (typeof BOT_SECRET_STATUSES)[number];

export function isBotSecretStatus(value: unknown): value is BotSecretStatus {
  return typeof value === "string" && (BOT_SECRET_STATUSES as readonly string[]).includes(value);
}

/** How the value authenticates to its one origin. */
export const BOT_SECRET_AUTH_TYPES = ["bearer", "header", "basic"] as const;

export type BotSecretAuth =
  | { readonly type: "bearer" }
  | { readonly type: "header"; readonly name: string }
  | { readonly type: "basic"; readonly username: string };

export interface BotSecretDestination {
  readonly name: string;
  /** The bare HTTPS origin, exactly as stored: scheme, host and port. */
  readonly origin: string;
  readonly auth: BotSecretAuth;
}

export type BotSecretDestinationRejection = "invalid_name" | "invalid_origin" | "invalid_auth";

export type BotSecretDestinationParse =
  | { readonly ok: true; readonly value: BotSecretDestination }
  | { readonly ok: false; readonly reason: BotSecretDestinationRejection };

/** An RFC 7230 token, the only shape a header name may take. */
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/;

/**
 * Header names a stored credential may never name. Framing and hop-by-hop
 * headers would let a credential rewrite the proxy's own request, and the
 * proxy's capability header is the run's proof of access rather than a
 * credential. The list is the credential side of the proxy's own
 * `FORBIDDEN_GRANT_HEADERS`, kept here so the tool layer refuses a destination
 * the proxy would refuse to inject.
 */
const forbiddenHeaderPattern =
  /^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|proxy-.*|sec-.*|.*forwarded.*|cookie|origin|referer|x-porkbot-proxy-token)$/i;

/** Whether a value is one of the name shapes a bot secret may take. */
export function isBotSecretName(value: unknown): value is string {
  return typeof value === "string" && BOT_SECRET_NAME_PATTERN.test(value);
}

/**
 * Whether a value is a bare HTTPS origin: no path beyond `/`, no query, no
 * fragment and no embedded credentials. The proxy checks the same shape when
 * it parses a grant, and `safeFetch` checks the address on the socket, so this
 * is the tool layer's early refusal rather than the only one.
 */
export function isBotSecretOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parses the authentication half of a destination, or `undefined`. */
export function parseBotSecretAuth(value: unknown): BotSecretAuth | undefined {
  const record = asRecord(value);

  if (record === undefined) {
    return undefined;
  }

  if (record["type"] === "bearer") {
    return { type: "bearer" };
  }

  if (record["type"] === "header") {
    const name = record["name"];

    if (
      typeof name !== "string" ||
      !headerNamePattern.test(name) ||
      forbiddenHeaderPattern.test(name)
    ) {
      return undefined;
    }

    return { type: "header", name };
  }

  if (record["type"] === "basic") {
    const username = record["username"];

    if (
      typeof username !== "string" ||
      username.length === 0 ||
      username.length > MAX_BOT_SECRET_USERNAME_LENGTH ||
      /[:\r\n]/.test(username)
    ) {
      return undefined;
    }

    return { type: "basic", username };
  }

  return undefined;
}

/**
 * Parses and normalizes one destination: the name must be addressable, the
 * origin must be bare HTTPS (a trailing slash is accepted and dropped), and the
 * authentication must be one of the three modes. The rejection reason names the
 * field, never the value.
 */
export function parseBotSecretDestination(value: unknown): BotSecretDestinationParse {
  const record = asRecord(value);

  if (record === undefined) {
    return { ok: false, reason: "invalid_name" };
  }

  const name = record["name"];

  if (!isBotSecretName(name)) {
    return { ok: false, reason: "invalid_name" };
  }

  const origin = record["origin"];

  if (!isBotSecretOrigin(origin)) {
    return { ok: false, reason: "invalid_origin" };
  }

  const auth = parseBotSecretAuth(record["auth"]);

  if (auth === undefined) {
    return { ok: false, reason: "invalid_auth" };
  }

  return { ok: true, value: { name, origin: new URL(origin).origin, auth } };
}

/**
 * Whether two destinations agree on the one origin and the authentication the
 * value would be sent with. The name is the row's identity and the caller's to
 * address, so a comparison that includes it would never be false.
 */
export function sameBotSecretDestination(
  left: BotSecretDestination,
  right: BotSecretDestination,
): boolean {
  if (left.origin !== right.origin || left.auth.type !== right.auth.type) {
    return false;
  }

  if (left.auth.type === "header" && right.auth.type === "header") {
    return left.auth.name === right.auth.name;
  }

  if (left.auth.type === "basic" && right.auth.type === "basic") {
    return left.auth.username === right.auth.username;
  }

  return true;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/**
 * The one request header a destination's value rides in. Bearer and basic
 * credentials use `authorization`; a named header carries the value unchanged.
 * The caller is the server-side proxy composition; this function's output is
 * the only shape in which a value leaves the store, and it never logs it.
 */
export function botSecretCredentialHeader(
  destination: BotSecretDestination,
  value: string,
): { readonly name: string; readonly value: string } {
  if (destination.auth.type === "header") {
    return { name: destination.auth.name, value };
  }

  if (destination.auth.type === "basic") {
    return {
      name: "authorization",
      value: `Basic ${base64Utf8(`${destination.auth.username}:${value}`)}`,
    };
  }

  return { name: "authorization", value: `Bearer ${value}` };
}
