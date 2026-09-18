import type { FailureMapping } from "./failures.ts";

/**
 * The transactional mail seam (PRD module map: provider interfaces live here).
 *
 * Password recovery and address verification are the product's only reasons to
 * send mail, and both are auth flows: the auth gate depends on this interface,
 * never on a transport. `@porkbot/adapters` supplies the implementations — a
 * deterministic offline emulator whose mailbox tests read, and one real
 * provider configured by URL and key (slice 3.5) — so no vendor name appears on
 * the auth side and "how does mail leave this deployment" is a registration
 * decision, not a code path.
 *
 * A message is plain data: the caller composes the subject and bodies, the
 * provider delivers. Tokens travel in `url` and in `text` because that is what
 * the recipient needs; they are never logged, which is why there is no
 * `metadata` field for a transport to echo back.
 */

export interface TransactionalEmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** What a provider reports about an accepted message; opaque to callers. */
export interface TransactionalEmailReceipt {
  readonly id: string;
}

/**
 * A provider is one method: hand it a message, get a receipt or a rejection.
 * Delivery is awaited, so a provider that cannot send (no configuration, a
 * refused recipient, a transport failure) fails the flow that needed the mail
 * rather than dropping it silently.
 */
export interface TransactionalEmailProvider {
  send(message: TransactionalEmailMessage): Promise<TransactionalEmailReceipt>;
}

/**
 * Failure mapping: the shipped provider classifies its errors as
 * `MailConfigurationError` (operator-facing, fail-closed) and
 * `MailDeliveryError` (status plus retryability), which map onto the shared
 * vocabulary as below. The table is exhaustive over `ProviderFailureKind` so a
 * new kind cannot be added without deciding what mail does with it.
 */
export const failureMapping: FailureMapping = {
  gone: "Not produced: a mail endpoint is stateless; a message is accepted or rejected, and there is no owned resource to lose.",
  not_found:
    "The endpoint or the recipient does not exist (HTTP 404); `MailDeliveryError` with `retryable: false`.",
  rate_limited:
    "The provider refuses work under a quota (HTTP 429); `MailDeliveryError` with `retryable: true`.",
  timed_out:
    "The transport aborted on the per-request timeout; `MailDeliveryError` with `retryable: true` and no status.",
  auth_failed:
    "The key is missing or refused (401/403); a store miss is `CredentialMissingError`, a refused key is `MailConfigurationError` with reason `rejected`.",
};
