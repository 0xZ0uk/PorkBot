import { WebAccessConfigurationError } from "./web-access-errors.ts";

/**
 * The constants and small helpers the two web-access implementations share, so
 * the emulator and the HTTP provider cannot drift on a budget or a URL rule.
 */

/** The body budget a request gets when it names none: 1 MiB of UTF-8. */
export const DEFAULT_MAX_BYTES = 1_000_000;

/** The per-request wall-clock budget: ten seconds, like the other adapters. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A request's body budget as a positive byte count. An absent budget takes the
 * default; anything else that is not a positive safe integer is refused rather
 * than silently rounded to something the caller did not ask for.
 */
export function resolveMaxBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_BYTES;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebAccessConfigurationError(
      "maxBytes",
      "invalid",
      "Expected a positive integer number of bytes for a response budget.",
    );
  }

  return value;
}

/** A search result count; absent means the provider's own ranking limit. */
export function resolveLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebAccessConfigurationError(
      "limit",
      "invalid",
      "Expected a positive integer number of search results.",
    );
  }

  return value;
}

/**
 * Decodes UTF-8 bytes, cutting a multi-byte character at the budget rather
 * than failing: the interface promises a truncated body, not a byte-exact one.
 */
export function decodeBounded(chunks: readonly Uint8Array[], total: number): string {
  const joined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(joined);
}
