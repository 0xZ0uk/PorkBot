import type { FailureMapping } from "./failures.ts";

/**
 * The notification seam (PRD decision 33; stories 22, 35).
 *
 * A run that finishes, fails, needs approval or stops making progress is worth
 * interrupting the operator for — and the operator, not the adapter, decides
 * which events those are. Preferences filter what reaches a provider; the
 * provider only delivers. Two implementations ship (slice 8.6): the offline
 * emulator whose mailbox tests read, and one real delivery path configured the
 * way every other seam is, by URL and credential name.
 *
 * A notification is plain data and deliberately small. It never carries secret
 * material and never carries raw tool arguments: the adapter is the last stop
 * before a third party, so what is not safe to hand a stranger is never in the
 * payload to begin with. Delivery is awaited, so a provider that cannot send
 * fails loudly and retries rather than dropping the message.
 *
 * Failure mapping: a provider raises an error that implements
 * `ProviderFailure`, classified by the `failureMapping` table below. Retry and
 * eventual surfacing are lifecycle decisions made from the kind.
 */

export interface OperatorNotification {
  readonly title: string;
  /** One paragraph an operator can read on a lock screen; no tool output. */
  readonly body: string;
  /** Deep link into the surface that owns the event, when one exists. */
  readonly url?: string;
}

/** What a provider reports about an accepted notification; opaque to callers. */
export interface NotificationReceipt {
  readonly id: string;
}

export interface NotificationProvider {
  deliver(notification: OperatorNotification): Promise<NotificationReceipt>;
}

export const failureMapping: FailureMapping = {
  gone: "Not produced: a notification is a fresh delivery with no owned resource; a destination that no longer answers classifies as `not_found` or `timed_out`.",
  not_found:
    "The destination cannot be reached (an unknown webhook URL answering 404, or an address the URL-safety rules refuse); surfaced to the operator instead of retried forever.",
  rate_limited:
    "The destination refuses work under a quota (HTTP 429); retried with backoff and eventually surfaced.",
  timed_out:
    "Delivery exceeded its budget, or the provider answered something that does not match the documented receipt; retried, then surfaced as an undelivered notification.",
  auth_failed:
    "The destination refuses the configured credential (401/403); surfaced to the operator, who can rotate it.",
};
