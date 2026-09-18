import type { ProviderFailure, ProviderFailureKind } from "@porkbot/adapter-kit";

/**
 * The typed failures a web-access provider can raise (slice 10.1).
 *
 * A configuration error is operator-facing and permanent: it names the setting
 * that is wrong and says what to do, and it carries no secret and no response
 * body — a destination is free to echo back whatever it was sent. A provider
 * failure is classified with the shared vocabulary instead, so lifecycle code
 * branches on the kind: `not_found` is a missing page the model may report,
 * `rate_limited` asks it to back off, `auth_failed` means a refused credential
 * or a destination the URL-safety rules will not reach, and `timed_out` covers
 * a transport failure, a 5xx and a response that does not match the contract.
 */

export type WebAccessConfigurationReason = "missing" | "invalid";

const reasonWords: Record<WebAccessConfigurationReason, string> = {
  missing: "is not configured",
  invalid: "is not valid",
};

export class WebAccessConfigurationError extends Error {
  /** Which operator setting is wrong: `endpoint`, `credential` or `maxBytes`. */
  readonly setting: string;
  readonly reason: WebAccessConfigurationReason;

  constructor(setting: string, reason: WebAccessConfigurationReason, guidance: string) {
    super(`Web access provider configuration: ${setting} ${reasonWords[reason]}. ${guidance}`);
    this.name = "WebAccessConfigurationError";
    this.setting = setting;
    this.reason = reason;
  }
}

/** A provider refusal translated into the shared lifecycle vocabulary. */
export class WebAccessProviderError extends Error implements ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly status: number | undefined;

  constructor(kind: ProviderFailureKind, detail: string, status?: number, options?: ErrorOptions) {
    super(`Web access provider failed (${kind}): ${detail}`, options);
    this.name = "WebAccessProviderError";
    this.kind = kind;
    this.detail = detail;
    this.status = status;
  }
}

export interface StatusFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
}

/**
 * How an HTTP status classifies, or `undefined` for 2xx. The body is never read
 * or quoted: only the status decides, and the text is operator-safe.
 */
export function statusFailure(status: number): StatusFailure | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }

  if (status === 401 || status === 403) {
    return { kind: "auth_failed", detail: "the destination refused the request" };
  }

  if (status === 404 || status === 410) {
    return { kind: "not_found", detail: "the destination does not exist" };
  }

  if (status === 429) {
    return { kind: "rate_limited", detail: "the destination is refusing work for now" };
  }

  return { kind: "timed_out", detail: `the destination answered HTTP ${status}` };
}
