import type { CredentialStore } from "@porkbot/adapter-kit";
import type { DeliveryLedger } from "@porkbot/db";
import { verifyWebhookSignature } from "@porkbot/effect";
import type { WebhookSignatureFailure } from "@porkbot/effect";
import type { Logger } from "@porkbot/logging";

/**
 * The verified webhook ingress (slice 4.5, PRD decision 24).
 *
 * `POST /webhooks/:source` is the one unauthenticated write surface the
 * deployment exposes, so its shape is the security property:
 *
 *   - The route is declared in the limits register as the `webhook` family, and
 *     it runs under the unauthenticated client principal — it never reads a
 *     session and never fabricates an actor. The handler receives provider data
 *     and nothing scoped to a tenant.
 *   - The signature is verified over the raw body before anything parses it;
 *     this module never parses the body at all, so an unsigned or wrongly-signed
 *     request has no path to a handler or a parser.
 *   - The freshness window and the timing-safe comparison live in
 *     `@porkbot/effect`'s signature module, so the ingress cannot ship a second
 *     implementation of either.
 *   - The delivery id is deduped in `@porkbot/db` under a NOT NULL unique key
 *     with a TTL: a replay is a no-op and the table stays bounded.
 *   - A handler failure releases the delivery, so a provider's redelivery is
 *     dispatched again instead of being deduped into a silent loss. That is
 *     what "idempotent by construction" pairs with: at most one dispatch per
 *     delivery id while the row stands, and a handler that can safely run again.
 *
 * A source's signing secret is resolved through the generic `CredentialStore`
 * seam (PRD decision 29), never from a provider-specific variable baked into
 * code: the operator names the source, and `webhookSecretName` derives the name
 * the secret is stored under.
 */

/** The mounted route: one path segment, the operator's source name. */
export const webhookPath = "/webhooks/:source";

/**
 * The pattern the limits register matches live request paths against. Hono's
 * `:source` is a route pattern, while the limiter compares literal request
 * paths, so the family is registered as the prefix it is.
 */
export const webhookRulePath = "/webhooks/*";

/** A longer delivery id than this is refused rather than stored. */
export const maxDeliveryIdLength = 200;

/**
 * The shape of a source name: lowercase letters, digits and interior dashes,
 * up to 64 characters. The route is public, so the name is validated before it
 * is used as a handler key or a credential name — the credential name folds
 * punctuation, and two sources that folded together would share a secret.
 */
const sourcePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isWebhookSource(source: string): boolean {
  return sourcePattern.test(source);
}

/**
 * The credential name a source's signing secret is stored under. The source is
 * operator-chosen data, so the derived name is generic: with the environment
 * store this is `PORKBOT_WEBHOOK_SECRET_<SOURCE>`, and any other store holds
 * the same name. The source has already passed `isWebhookSource`, so folding
 * its dashes cannot collide two different sources onto one name.
 */
export function webhookSecretName(source: string): string {
  return `PORKBOT_WEBHOOK_SECRET_${source.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * One raw ingress request. `body` is the exact bytes the sender signed: it is
 * read once and handed on unparsed, because verification is meaningless after
 * any decode.
 */
export interface WebhookRequest {
  readonly source: string;
  readonly signature: string | undefined;
  readonly deliveryId: string | undefined;
  readonly body: Uint8Array;
}

/** What a registered handler receives, after verification and dedupe. */
export interface WebhookEvent {
  readonly source: string;
  readonly deliveryId: string;
  /** The exact body the provider signed; the handler parses it. */
  readonly body: Uint8Array;
}

export type WebhookHandler = (event: WebhookEvent) => Promise<void>;

/** Why an ingress request was refused. Each one is logged; none is returned. */
export type WebhookRejection =
  | "unknown_source"
  | "unconfigured_source"
  | "missing_delivery"
  | "invalid_delivery"
  | "missing_signature"
  | "malformed_signature"
  | "stale_signature"
  | "future_signature"
  | "bad_signature";

export type WebhookOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate" }
  | { readonly status: "rejected"; readonly reason: WebhookRejection };

export interface WebhookIngress {
  /** Verifies, dedupes and dispatches one request; never parses the body. */
  receive(request: WebhookRequest): Promise<WebhookOutcome>;
}

export interface WebhookIngressOptions {
  readonly secrets: CredentialStore;
  readonly deliveries: DeliveryLedger;
  readonly handlers: ReadonlyMap<string, WebhookHandler>;
  readonly logger: Logger;
  /** The clock the freshness window and the delivery TTL are measured against. */
  readonly now?: () => Date;
}

export function createWebhookIngress(options: WebhookIngressOptions): WebhookIngress {
  const now = options.now ?? (() => new Date());

  return {
    async receive(request: WebhookRequest): Promise<WebhookOutcome> {
      // The name is validated before it becomes a handler key or a credential
      // name. A name outside the canonical shape is refused like an unknown
      // source, so the response cannot be used to probe the naming rules.
      if (!isWebhookSource(request.source)) {
        options.logger.warn("webhook source name is not canonical", { source: request.source });
        return { status: "rejected", reason: "unknown_source" };
      }

      const handler = options.handlers.get(request.source);

      if (handler === undefined) {
        // Fail closed before anything else: an unknown source has no secret to
        // verify against and no handler to dispatch to. The response does not
        // say which of the two it was. A registered source pays for a secret
        // lookup and an HMAC where an unknown one does not, but the flat 401
        // keeps that difference out of the response.
        options.logger.warn("webhook source is not registered", { source: request.source });
        return { status: "rejected", reason: "unknown_source" };
      }

      const secret = await options.secrets.resolve(webhookSecretName(request.source));

      if (secret === undefined || secret.trim() === "") {
        options.logger.warn("webhook source has no signing secret", { source: request.source });
        return { status: "rejected", reason: "unconfigured_source" };
      }

      const verdict = verifyWebhookSignature({
        secret,
        signature: request.signature,
        body: request.body,
        nowSeconds: Math.floor(now().getTime() / 1_000),
      });

      if (!verdict.valid) {
        options.logger.warn("webhook signature was refused", {
          source: request.source,
          reason: verdict.reason,
        });
        return { status: "rejected", reason: signatureRejection(verdict.reason) };
      }

      const deliveryId = request.deliveryId?.trim();

      if (deliveryId === undefined || deliveryId === "") {
        options.logger.warn("webhook delivery id is missing", { source: request.source });
        return { status: "rejected", reason: "missing_delivery" };
      }

      if (deliveryId.length > maxDeliveryIdLength) {
        options.logger.warn("webhook delivery id is too long", {
          source: request.source,
          length: deliveryId.length,
        });
        return { status: "rejected", reason: "invalid_delivery" };
      }

      const recorded = await options.deliveries.record({
        source: request.source,
        deliveryId,
        now: now(),
      });

      if (!recorded) {
        // The id was already accepted inside its window: the provider's
        // redelivery is acknowledged and dispatched nowhere.
        options.logger.info("webhook delivery is a replay", {
          source: request.source,
          deliveryId,
        });
        return { status: "duplicate" };
      }

      try {
        await handler({ source: request.source, deliveryId, body: request.body });
      } catch (error) {
        await options.deliveries
          .release({ source: request.source, deliveryId })
          .catch((releaseError: unknown) => {
            // A release that fails must not hide why the handler threw; the
            // delivery then stays deduped, which the log line makes visible.
            options.logger.error("failed to release a webhook delivery", {
              source: request.source,
              deliveryId,
              error: releaseError,
            });
          });

        throw error;
      }

      return { status: "accepted" };
    },
  };
}

/**
 * The fail-closed ingress a process without webhook configuration mounts: every
 * request is refused with the same answer an unknown source gets. The route
 * exists and is declared; it dispatches nothing until an operator registers a
 * source and its secret.
 */
export function refuseWebhooks(logger: Logger): WebhookIngress {
  return {
    async receive(request: WebhookRequest): Promise<WebhookOutcome> {
      logger.warn("webhook ingress is not configured", { source: request.source });
      return { status: "rejected", reason: "unknown_source" };
    },
  };
}

function signatureRejection(reason: WebhookSignatureFailure): WebhookRejection {
  switch (reason) {
    case "missing":
      return "missing_signature";
    case "malformed":
      return "malformed_signature";
    case "stale":
      return "stale_signature";
    case "future":
      return "future_signature";
    case "mismatch":
      return "bad_signature";
  }
}
