import { isProviderFailure } from "@porkbot/adapter-kit";
import type { NotificationProvider, ProviderFailureKind } from "@porkbot/adapter-kit";
import { backoffDelayMs } from "@porkbot/core";
import type { BackoffOptions, NotificationKind } from "@porkbot/core";
import type { Logger } from "@porkbot/logging";
import type { NotificationEligibility, NotificationRecipients } from "./notification-store.ts";

/**
 * Notification delivery (slice 8.6, PRD decision 33; stories 35).
 *
 * One path from "something happened" to "an operator was told", with the
 * decisions the acceptance criteria name made here and nowhere else:
 *
 *   - Preferences decide. The recipient's eligibility is read from the
 *     actor-scoped store before the provider is asked anything, so a quiet
 *     preference or a user outside the space suppresses the delivery instead of
 *     the provider deciding. A suppressed delivery never touches the network.
 *   - Failures are retried and surfaced. `rate_limited` and `timed_out` — the
 *     provider refusing for now or answering too slowly — are retried with
 *     bounded exponential backoff from `@porkbot/core`; `auth_failed`,
 *     `not_found` and `gone` are permanent and are not retried into a loop.
 *     Either way the delivery comes back as an outcome the caller must hold —
 *     `delivered`, `suppressed` or `undelivered` — and an undelivered one is
 *     logged at error level and handed to `onOutcome`, so it is visible rather
 *     than swallowed. A failure that is not a classified provider failure is a
 *     bug in the adapter and is rethrown, not folded into an outcome.
 *   - The content is the three fields the interface names. The adapter is the
 *     last stop before a stranger and drops whatever else it is handed; this
 *     path never composes a title or body from tool arguments.
 *
 * The provider is the adapter-kit seam, so the offline emulator exercises this
 * whole path with no key and no network; the durable side of the recipient
 * check arrives as the `NotificationRecipients` seam.
 */

export interface NotificationDeliveryRequest {
  /** The space member the notification is for; a non-member is suppressed. */
  readonly recipientUserId: string;
  /** Which event this is, so the recipient's preference can decide. */
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  /** A deep link into the surface that owns the event, when one exists. */
  readonly url?: string;
}

/** Why a delivery did not reach the provider. */
export type NotificationSuppressionReason = "preference" | "not_a_recipient";

/**
 * The result of one delivery attempt series. It is deliberately not thrown:
 * a run must not fail because a notification could not be sent, and a caller
 * that ignores the value has already been told in the log.
 */
export type NotificationDeliveryOutcome =
  | {
      readonly status: "delivered";
      readonly receiptId: string;
      readonly attempts: number;
    }
  | {
      readonly status: "suppressed";
      readonly reason: NotificationSuppressionReason;
    }
  | {
      readonly status: "undelivered";
      readonly failureKind: ProviderFailureKind;
      readonly detail: string;
      readonly attempts: number;
    };

export interface NotificationDeliveryOptions {
  readonly provider: NotificationProvider;
  readonly recipients: NotificationRecipients;
  /** Total attempts per delivery, including the first; defaults to three. */
  readonly maxAttempts?: number;
  /** Applied between retries, through core's `backoffDelayMs`. */
  readonly backoff?: BackoffOptions;
  /** The wait between attempts; injectable so a test needs no wall clock. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Called once per outcome, after the log line, for the caller's own surface. */
  readonly onOutcome?: (outcome: NotificationDeliveryOutcome) => void;
  readonly logger?: Logger;
}

export interface NotificationDelivery {
  deliver(request: NotificationDeliveryRequest): Promise<NotificationDeliveryOutcome>;
}

const defaultMaxAttempts = 3;

/**
 * The kinds worth retrying: the provider is refusing work for now or did not
 * answer in budget. The rest are permanent facts an operator has to fix, so
 * retrying them would only delay the surfacing.
 */
const retryableFailureKinds: ReadonlySet<ProviderFailureKind> = new Set([
  "rate_limited",
  "timed_out",
]);

function resolveMaxAttempts(raw: number | undefined): number {
  if (raw === undefined) {
    return defaultMaxAttempts;
  }

  if (!Number.isSafeInteger(raw) || raw < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, received ${String(raw)}`);
  }

  return raw;
}

function suppressionReason(eligibility: NotificationEligibility): NotificationSuppressionReason {
  return eligibility === "not_a_recipient" ? "not_a_recipient" : "preference";
}

export function createNotificationDelivery(
  options: NotificationDeliveryOptions,
): NotificationDelivery {
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const sleep =
    options.sleep ??
    ((milliseconds: number): Promise<void> => {
      return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });
    });

  function finish(outcome: NotificationDeliveryOutcome): NotificationDeliveryOutcome {
    switch (outcome.status) {
      case "delivered":
        options.logger?.debug("notification delivered", {
          attempts: outcome.attempts,
          receiptId: outcome.receiptId,
        });
        break;
      case "suppressed":
        options.logger?.debug("notification suppressed", { reason: outcome.reason });
        break;
      case "undelivered":
        options.logger?.error("notification undelivered", {
          attempts: outcome.attempts,
          failureKind: outcome.failureKind,
          detail: outcome.detail,
        });
        break;
    }

    options.onOutcome?.(outcome);

    return outcome;
  }

  return {
    async deliver(request: NotificationDeliveryRequest): Promise<NotificationDeliveryOutcome> {
      const eligibility = await options.recipients.eligibility(
        request.recipientUserId,
        request.kind,
      );

      if (eligibility !== "enabled") {
        return finish({ status: "suppressed", reason: suppressionReason(eligibility) });
      }

      const notification = {
        title: request.title,
        body: request.body,
        ...(request.url === undefined ? {} : { url: request.url }),
      };

      let attempts = 0;

      for (;;) {
        attempts += 1;

        try {
          const receipt = await options.provider.deliver(notification);

          return finish({ status: "delivered", receiptId: receipt.id, attempts });
        } catch (error) {
          // A value that is not a classified provider failure is a programming
          // error in the adapter; swallowing it here would hide the bug.
          if (!isProviderFailure(error)) {
            throw error;
          }

          if (!retryableFailureKinds.has(error.kind) || attempts >= maxAttempts) {
            return finish({
              status: "undelivered",
              failureKind: error.kind,
              detail: error.detail ?? (error instanceof Error ? error.message : error.kind),
              attempts,
            });
          }

          await sleep(backoffDelayMs(attempts, options.backoff));
        }
      }
    },
  };
}
