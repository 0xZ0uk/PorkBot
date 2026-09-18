import type { ProviderFailure, ProviderFailureKind } from "@porkbot/adapter-kit";

/**
 * The typed failures a notification provider can raise.
 *
 * A configuration error is operator-facing and permanent: it names the setting
 * that is wrong and says what to do, and it carries no secret and no provider
 * response body — a provider is free to echo the key it just rejected. A
 * provider failure is classified with the shared vocabulary instead, because
 * delivery branches on it: `rate_limited` and `timed_out` are retried with
 * backoff, while `not_found` and `auth_failed` are surfaced to the operator
 * rather than retried forever. `gone` is not produced by this seam — a
 * notification is a fresh delivery with no owned resource — and the mapping in
 * `@porkbot/adapter-kit` says so.
 */
export type NotificationConfigurationReason =
  /** The setting was not provided at all. */
  | "missing"
  /** The setting was provided but cannot be used. */
  | "invalid"
  /** The provider refused the configured credential. */
  | "rejected";

const reasonWords: Record<NotificationConfigurationReason, string> = {
  missing: "is not configured",
  invalid: "is not valid",
  rejected: "was refused by the provider",
};

export class NotificationConfigurationError extends Error {
  /** Which operator setting is wrong: `endpoint` or `credential`. */
  readonly setting: string;
  readonly reason: NotificationConfigurationReason;

  constructor(setting: string, reason: NotificationConfigurationReason, guidance: string) {
    super(`Notification provider configuration: ${setting} ${reasonWords[reason]}. ${guidance}`);
    this.name = "NotificationConfigurationError";
    this.setting = setting;
    this.reason = reason;
  }
}

/** A provider refusal translated into the shared lifecycle vocabulary. */
export class NotificationProviderError extends Error implements ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly status: number | undefined;

  constructor(kind: ProviderFailureKind, detail: string, status?: number, options?: ErrorOptions) {
    super(`Notification provider failed (${kind}): ${detail}`, options);
    this.name = "NotificationProviderError";
    this.kind = kind;
    this.detail = detail;
    this.status = status;
  }
}
