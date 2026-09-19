/**
 * The serialized form of one MCP server's credential (slice 9.5).
 *
 * An installed server has up to two secrets: the OAuth client credentials the
 * operator supplied, and the tokens the callback exchanged them for. They live
 * in one encrypted credential row under the server's `credentialName`, as this
 * small JSON document, so the encrypted store stays the only place a secret
 * rests and the provider layer only ever sees a value passed for one request.
 *
 * The codec is deliberately forgiving on read and strict on write: a row that
 * does not parse yields `{}` — fail closed, because the provider then reports
 * `auth_failed` rather than inventing a token — and only non-blank strings are
 * carried. Nothing here logs, and toString is never used on a value.
 */

export interface McpCredential {
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly accessToken?: string | undefined;
  readonly refreshToken?: string | undefined;
  /** ISO-8601 expiry of `accessToken`, when the token endpoint named one. */
  readonly expiresAt?: string | undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Parses a stored credential; anything unusable answers an empty credential. */
export function parseMcpCredential(raw: string | undefined): McpCredential {
  if (raw === undefined || raw.trim() === "") {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const clientId = nonBlank(record["clientId"]);
  const clientSecret = nonBlank(record["clientSecret"]);
  const accessToken = nonBlank(record["accessToken"]);
  const refreshToken = nonBlank(record["refreshToken"]);
  const expiresAt = nonBlank(record["expiresAt"]);

  return {
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** Serializes a credential, dropping undeclared or blank fields. */
export function serializeMcpCredential(credential: McpCredential): string {
  return JSON.stringify(parseMcpCredential(JSON.stringify(credential)));
}
