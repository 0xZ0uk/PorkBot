import type { ProviderFailure, ProviderFailureKind } from "@porkbot/adapter-kit";

/**
 * The typed failures a memory provider can raise.
 *
 * A configuration error is operator-facing and permanent: it names the setting
 * that is wrong and says what to do, and it carries no secret and no provider
 * response body — a provider is free to echo the key it just rejected. A
 * provider failure is classified with the shared vocabulary instead, because
 * recall degrades on it: a `rate_limited`, `timed_out` or `auth_failed` index
 * falls back to lexical matching rather than failing a run, and the operator
 * sees the classification through the recall seam's degradation report.
 */
export type MemoryConfigurationReason =
  /** The setting was not provided at all. */
  | "missing"
  /** The setting was provided but cannot be used. */
  | "invalid"
  /** The provider refused the configured credential. */
  | "rejected";

const reasonWords: Record<MemoryConfigurationReason, string> = {
  missing: "is not configured",
  invalid: "is not valid",
  rejected: "was refused by the provider",
};

export class MemoryConfigurationError extends Error {
  /** Which operator setting is wrong: `endpoint` or `credential`. */
  readonly setting: string;
  readonly reason: MemoryConfigurationReason;

  constructor(setting: string, reason: MemoryConfigurationReason, guidance: string) {
    super(`Memory provider configuration: ${setting} ${reasonWords[reason]}. ${guidance}`);
    this.name = "MemoryConfigurationError";
    this.setting = setting;
    this.reason = reason;
  }
}

/** A provider refusal translated into the shared lifecycle vocabulary. */
export class MemoryProviderError extends Error implements ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly status: number | undefined;

  constructor(kind: ProviderFailureKind, detail: string, status?: number, options?: ErrorOptions) {
    super(`Memory provider failed (${kind}): ${detail}`, options);
    this.name = "MemoryProviderError";
    this.kind = kind;
    this.detail = detail;
    this.status = status;
  }
}
