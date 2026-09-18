/**
 * Redaction for log records. Two rules run over everything the logger writes:
 *
 *   1. Fields whose name is a secret by name (`key`, `token`, `secret`,
 *      `password`, plus credential-carrying names such as `authorization` and
 *      `cookie`) are replaced with `[redacted]`.
 *   2. String values are scrubbed of known secret shapes (`Bearer …`, `sk-…`,
 *      JWTs, database URLs with credentials, PEM private keys, `password=…`).
 *   3. A string longer than `maxLoggedStringLength` becomes `[truncated]`
 *      without being scanned, so a large caller-supplied value cannot make the
 *      scanner itself the attack.
 *
 * Every rule is fail-closed: a secret matched by a rule is removed, an
 * oversized value is not logged at all, and keeping one in the output requires
 * the explicit, review-visible `unredacted()` marker (PRD stack decision 10).
 */

export const redactedPlaceholder = "[redacted]";
export const truncatedPlaceholder = "[truncated]";
export const circularPlaceholder = "[circular]";

/** Depth beyond which a value is replaced with `[truncated]`. */
export const maxRedactDepth = 8;

/** Field names that are secret by name and require `unredacted()` to log. */
export const sensitiveFieldNames = ["key", "token", "secret", "password"] as const;

export type SensitiveFieldName = (typeof sensitiveFieldNames)[number];

/** Credential-carrying names that are redacted for the same reason. */
const credentialFieldNames = ["authorization", "cookie", "credential"] as const;

const sensitiveWords: ReadonlySet<string> = new Set([
  ...sensitiveFieldNames,
  ...credentialFieldNames,
]);

/**
 * Splits a field name into lowercase words, so camelCase, snake_case and
 * header-style names all end in the same token. `apiKey`, `api_key` and
 * `X-Api-Key` are one rule.
 */
function fieldWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * Ordinary words that end in a sensitive word but are not secrets. Kept short
 * and documented so the fail-closed suffix rule below stays predictable.
 */
const ordinaryWordsEndingInSensitive = new Set(["monkey", "turkey", "donkey"]);

/**
 * Whether a field name is a secret by name. The last word decides, so `token`
 * and `accessToken` are sensitive while `tokenizer` and `keyId` are not. The
 * plural of a sensitive word is sensitive too (`tokens`, `credentials`), and
 * so is a fused compound (`apikey`, `dbpassword`), except the ordinary words
 * above.
 */
export function isSensitiveFieldName(name: string): boolean {
  const words = fieldWords(name);
  const last = words[words.length - 1];
  if (last === undefined) {
    return false;
  }

  if (sensitiveWords.has(last)) {
    return true;
  }

  if (last.endsWith("s") && sensitiveWords.has(last.slice(0, -1))) {
    return true;
  }

  if (ordinaryWordsEndingInSensitive.has(last)) {
    return false;
  }

  for (const sensitive of sensitiveWords) {
    if (last.endsWith(sensitive)) {
      return true;
    }
  }

  return false;
}

interface SecretPattern {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const secretPatterns: readonly SecretPattern[] = [
  // Authorization headers: keep the scheme, remove the credential.
  { pattern: /\b(Bearer[ \t]+)[A-Za-z0-9._~+/=-]+/gi, replacement: `$1${redactedPlaceholder}` },
  { pattern: /\b(Basic[ \t]+)[A-Za-z0-9+/=]+/gi, replacement: `$1${redactedPlaceholder}` },
  // Vendor key formats.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: redactedPlaceholder },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: redactedPlaceholder },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: redactedPlaceholder },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: redactedPlaceholder },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: redactedPlaceholder },
  // JSON Web Tokens: three base64url segments, the first starting with `eyJ`.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replacement: redactedPlaceholder,
  },
  // Connection strings: keep the scheme, remove user and password.
  {
    pattern:
      /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|https?|ftps?):\/\/)[^/\s:@]*:[^/\s:@]+@/gi,
    replacement: `$1${redactedPlaceholder}@`,
  },
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: redactedPlaceholder,
  },
];
/**
 * Assignments inside free text (`dbPassword=hunter2`, `access_token: "…"`)
 * are decided by the same `isSensitiveFieldName` rule as object fields, so the
 * two cannot drift: `monkey=banana` is not a password, `dbPassword=…` is.
 *
 * This is a scanner rather than a single `replace` because matches must be
 * allowed to overlap: in `refresh: token=…` the ordinary `refresh: …` must not
 * swallow the sensitive `token=…` inside its value.
 */
const assignmentPattern =
  /([A-Za-z0-9_.-]+)(\s*["']?\s*[:=]\s*)((?:Bearer[ \t]+|Basic[ \t]+)?("[^"]*"|'[^']*'|[^\s&,;]+))/g;

function redactAssignments(value: string): string {
  const pattern = new RegExp(assignmentPattern.source, assignmentPattern.flags);
  let result = "";
  let copiedUpTo = 0;
  let match = pattern.exec(value);

  while (match !== null) {
    const name = match[1] ?? "";
    const separator = match[2] ?? "";

    if (isSensitiveFieldName(name)) {
      result += value.slice(copiedUpTo, match.index) + name + separator + redactedPlaceholder;
      copiedUpTo = match.index + match[0].length;
    } else {
      pattern.lastIndex = match.index + name.length + separator.length;
    }

    match = pattern.exec(value);
  }

  return result + value.slice(copiedUpTo);
}

/**
 * The longest string a redacted log line carries. Anything longer is replaced
 * whole with `[truncated]` before any pattern scans it. Two reasons, in order:
 * a secret must not reach a log, so the replacement is fail-closed — a secret
 * straddling a cut would leak its head — and scanning an unbounded,
 * caller-supplied string for secret shapes is work the caller chooses. A
 * validation error carries its input as the error's cause, so without the
 * bound a large invalid request makes the scanner run for minutes (the
 * assignment scanner is quadratic on a long separator-free token).
 */
export const maxLoggedStringLength = 4_096;

/** Replaces every known secret shape inside a string. */
export function redactString(value: string): string {
  if (value.length > maxLoggedStringLength) {
    return truncatedPlaceholder;
  }

  return secretPatterns.reduce(
    (result, { pattern, replacement }) => result.replace(pattern, replacement),
    redactAssignments(value),
  );
}

function decodeQueryName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/**
 * Redacts sensitive query parameters in a request path before it is logged, so
 * `/oauth/callback?access_token=…` keeps its shape without the credential. The
 * rest of the path and the remaining query values are still shape-scrubbed,
 * and the original encoding of untouched pairs is preserved.
 */
export function redactPath(path: string): string {
  const queryStart = path.indexOf("?");
  if (queryStart === -1) {
    return redactString(path);
  }

  const base = path.slice(0, queryStart);
  const pairs = path
    .slice(queryStart + 1)
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      if (separator === -1) {
        return isSensitiveFieldName(decodeQueryName(pair))
          ? redactedPlaceholder
          : redactString(pair);
      }

      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      return `${name}=${isSensitiveFieldName(decodeQueryName(name)) ? redactedPlaceholder : redactString(value)}`;
    });

  return `${redactString(base)}?${pairs.join("&")}`;
}

const unredactedMarker: unique symbol = Symbol("porkbot.logging.unredacted");

/**
 * A value marked as safe to log verbatim. Construct one with `unredacted()`;
 * the marker is intentionally awkward so that every place a secret reaches a
 * log is visible as an explicit opt-in in review.
 */
export interface Unredacted<T = unknown> {
  readonly [unredactedMarker]: T;
}

export function unredacted<T>(value: T): Unredacted<T> {
  return { [unredactedMarker]: value };
}

export function isUnredacted(value: unknown): value is Unredacted {
  return typeof value === "object" && value !== null && unredactedMarker in value;
}

interface ConversionState {
  readonly depth: number;
  readonly seen: WeakSet<object>;
  readonly redactValues: boolean;
}

function next(state: ConversionState): ConversionState {
  return { depth: state.depth + 1, seen: state.seen, redactValues: state.redactValues };
}

function convertError(error: Error, state: ConversionState): Record<string, unknown> {
  const record: Record<string, unknown> = {
    name: error.name,
    message: state.redactValues ? redactString(error.message) : error.message,
  };

  if (typeof error.stack === "string") {
    record["stack"] = state.redactValues ? redactString(error.stack) : error.stack;
  }

  // Custom own properties (`code`, `statusCode`, …) survive error logging too,
  // redacted by the same rules as any other record.
  for (const [key, value] of Object.entries(error)) {
    if (
      key === "name" ||
      key === "message" ||
      key === "stack" ||
      key === "cause" ||
      key === "errors"
    ) {
      continue;
    }
    if (state.redactValues && isSensitiveFieldName(key) && !isUnredacted(value)) {
      record[key] = redactedPlaceholder;
      continue;
    }
    record[key] = convert(value, next(state));
  }

  if (error.cause !== undefined) {
    record["cause"] = convert(error.cause, next(state));
  }

  const nestedErrors = (error as { errors?: unknown }).errors;
  if (Array.isArray(nestedErrors)) {
    record["errors"] = nestedErrors.map((entry) => convert(entry, next(state)));
  }

  return record;
}

function convert(value: unknown, state: ConversionState): unknown {
  if (isUnredacted(value)) {
    return convert(value[unredactedMarker], { ...state, redactValues: false });
  }

  if (value === null || value === undefined) {
    return value;
  }

  switch (typeof value) {
    case "string":
      return state.redactValues ? redactString(value) : value;
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return undefined;
    case "object":
      break;
  }

  if (state.depth >= maxRedactDepth) {
    return truncatedPlaceholder;
  }

  if (state.seen.has(value)) {
    return circularPlaceholder;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    const href = value.href;
    return state.redactValues ? redactString(href) : href;
  }

  state.seen.add(value);
  try {
    if (value instanceof Error) {
      return convertError(value, state);
    }

    if (Array.isArray(value)) {
      return value.map((entry) => convert(entry, next(state)));
    }

    if (value instanceof Map) {
      const record: Record<string, unknown> = {};
      for (const [key, entry] of value) {
        const name = String(key);
        if (state.redactValues && isSensitiveFieldName(name) && !isUnredacted(entry)) {
          record[name] = redactedPlaceholder;
          continue;
        }
        record[name] = convert(entry, next(state));
      }
      return record;
    }

    if (value instanceof Set) {
      return [...value].map((entry) => convert(entry, next(state)));
    }

    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // The opt-in wins over the field-name rule: an explicit `unredacted()`
      // marker is exactly the review-visible exception the rule exists for.
      if (state.redactValues && isSensitiveFieldName(key) && !isUnredacted(entry)) {
        record[key] = redactedPlaceholder;
        continue;
      }
      record[key] = convert(entry, next(state));
    }
    return record;
  } finally {
    state.seen.delete(value);
  }
}

/** Redacts a value deeply into a JSON-safe shape. Never mutates the input. */
export function redact(value: unknown): unknown {
  return convert(value, { depth: 0, seen: new WeakSet(), redactValues: true });
}

/** Redacts a fields object, always returning an object the logger can spread. */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result = redact(record);
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return {};
}
