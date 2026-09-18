/**
 * The typed failures a transactional mail provider can raise.
 *
 * Configuration errors are operator-facing: they name the setting that is wrong
 * and say what to do, and they carry no secret and no provider response body.
 * That last rule is deliberate — a provider that echoes a rejected API key in
 * its error JSON would otherwise put the key into a log line, and the PRD says
 * secret material never appears in logs or errors. Delivery errors separate the
 * two decisions a caller can make: retry a transient failure, or surface a
 * permanent rejection.
 */

export type MailConfigurationReason =
  /** The setting was not provided at all. */
  | "missing"
  /** The setting was provided but cannot be used. */
  | "invalid"
  /** The provider refused the configured credential. */
  | "rejected";

const reasonWords: Record<MailConfigurationReason, string> = {
  missing: "is not configured",
  invalid: "is not valid",
  rejected: "was refused by the provider",
};

export class MailConfigurationError extends Error {
  /** Which operator setting is wrong: `endpoint`, `sender` or `credential`. */
  readonly setting: string;
  readonly reason: MailConfigurationReason;

  constructor(setting: string, reason: MailConfigurationReason, guidance: string) {
    super(`Transactional mail configuration: ${setting} ${reasonWords[reason]}. ${guidance}`);
    this.name = "MailConfigurationError";
    this.setting = setting;
    this.reason = reason;
  }
}

export interface MailDeliveryFailure {
  /** The HTTP status, or `undefined` when the transport itself failed. */
  readonly status?: number;
  /** Whether the same message could succeed on a later attempt. */
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class MailDeliveryError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(failure: MailDeliveryFailure) {
    const where = failure.status === undefined ? "" : ` (HTTP ${failure.status})`;
    const advice = failure.retryable ? " The failure looks transient." : "";

    super(`Transactional mail delivery failed${where}.${advice}`, {
      ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    });
    this.name = "MailDeliveryError";
    this.status = failure.status;
    this.retryable = failure.retryable;
  }
}
