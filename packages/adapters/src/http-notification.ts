import type {
  CredentialStore,
  NotificationProvider,
  NotificationReceipt,
  OperatorNotification,
} from "@porkbot/adapter-kit";
import { BlockedUrlError, safeFetch } from "@porkbot/effect";
import type { SafeFetch } from "@porkbot/effect";
import {
  NotificationConfigurationError,
  NotificationProviderError,
} from "./notification-errors.ts";

/**
 * The one real notification provider: an HTTPS JSON webhook configured by URL
 * and credential name, like every other seam. It speaks this contract, so a
 * chat webhook, a push gateway or an internal alerting service can sit behind
 * it:
 *
 *   POST {endpoint}
 *   Authorization: Bearer {key}
 *   Content-Type: application/json
 *   { "title": "…", "body": "…", "url": "…"? }
 *
 *   any 2xx: { "id": "…" }
 *
 * The key is never a constructor argument and never an environment read: it is
 * resolved by name from the injected `CredentialStore` on every delivery, which
 * keeps rotation a store concern and the secret out of adapter configuration.
 * Provider response bodies are never included in an error, because a provider
 * is free to echo the key it just rejected.
 *
 * The request body is built from an allowlist of exactly the three fields the
 * notification interface names — never spread from the caller's object — so a
 * notification that somehow carries a credential or a raw tool argument beside
 * its title and body cannot reach a third party through this adapter. This is
 * the last stop before a stranger, and what is not safe to hand a stranger is
 * dropped here even if it was in the payload to begin with.
 *
 * Failures are classified with the shared vocabulary because delivery is
 * retried and eventually surfaced on them: a refused credential is `auth_failed`
 * and a destination that is gone is `not_found` — both surfaced to the operator
 * rather than retried forever — while a quota (`rate_limited`), a transport
 * failure, a timeout, a 5xx or a response that does not match the contract is
 * retried with backoff. A destination the URL-safety rules refuse is surfaced
 * as `not_found` without a retry, and the endpoint URL itself is checked at
 * construction — including plain HTTP, which the shipped transport never dials
 * — where the operator can fix it.
 */

export interface HttpNotificationProviderOptions {
  /**
   * Absolute webhook URL that accepts the documented contract, for example
   * `https://alerts.example.invalid/notify`. Embedded credentials are rejected:
   * the key belongs in the credential store.
   */
  readonly endpoint: string;
  /** The name the webhook key is stored under in the credential store. */
  readonly credentialName: string;
  /** Resolves the webhook key; the parameter is never read from the environment here. */
  readonly credentials: CredentialStore;
  /**
   * Transport seam for the offline wire emulator, which speaks plain HTTP on
   * loopback; defaults to the URL-safety module's `safeFetch`, so a shipped
   * deployment only ever dials an HTTPS endpoint whose resolved address is
   * public (PRD decision 23).
   */
  readonly fetch?: SafeFetch;
  /** Per-request budget; defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

const defaultTimeoutMs = 10_000;

function resolveEndpoint(raw: string): URL {
  const endpoint = raw.trim();

  if (endpoint === "") {
    throw new NotificationConfigurationError(
      "endpoint",
      "missing",
      "Set the notification webhook URL, for example https://alerts.example.invalid/notify.",
    );
  }

  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    throw new NotificationConfigurationError(
      "endpoint",
      "invalid",
      "Expected an absolute http(s) URL, for example https://alerts.example.invalid/notify.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new NotificationConfigurationError(
      "endpoint",
      "invalid",
      `Expected an http(s) URL, got "${url.protocol}" instead.`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new NotificationConfigurationError(
      "endpoint",
      "invalid",
      "Remove the credentials from the URL and store the key in the credential store.",
    );
  }

  return url;
}

function resolveCredentialName(raw: string): string {
  const name = raw.trim();

  if (name === "") {
    throw new NotificationConfigurationError(
      "credential",
      "missing",
      "Name the credential store entry that holds the webhook key.",
    );
  }

  return name;
}

function resolveTimeout(raw: number | undefined): number {
  if (raw === undefined) {
    return defaultTimeoutMs;
  }

  if (!Number.isFinite(raw) || raw <= 0) {
    throw new NotificationConfigurationError(
      "timeoutMs",
      "invalid",
      "Expected a positive number of milliseconds.",
    );
  }

  return raw;
}

async function readReceipt(response: Response): Promise<NotificationReceipt> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new NotificationProviderError(
      "timed_out",
      "the delivery response was not JSON",
      response.status,
    );
  }

  const id =
    typeof payload === "object" && payload !== null && "id" in payload
      ? (payload as { readonly id?: unknown }).id
      : undefined;

  if (typeof id !== "string" || id.trim() === "") {
    throw new NotificationProviderError(
      "timed_out",
      "the delivery response did not match the documented contract",
      response.status,
    );
  }

  return { id };
}

export function createHttpNotificationProvider(
  options: HttpNotificationProviderOptions,
): NotificationProvider {
  const endpoint = resolveEndpoint(options.endpoint);

  // The shipped transport (the URL-safety module's `safeFetch`) only ever dials
  // HTTPS, so a plain-HTTP endpoint is a configuration fact caught here, at
  // boot, rather than at the first notification. A caller that supplies a
  // `fetch` of its own — the offline wire emulator on loopback — takes over
  // that decision and may speak HTTP.
  if (options.fetch === undefined && endpoint.protocol === "http:") {
    throw new NotificationConfigurationError(
      "endpoint",
      "invalid",
      "Expected an https endpoint; the shipped transport refuses plain HTTP.",
    );
  }

  const credentialName = resolveCredentialName(options.credentialName);
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const fetchImpl = options.fetch ?? safeFetch;

  return {
    async deliver(notification: OperatorNotification): Promise<NotificationReceipt> {
      const credential = await options.credentials.resolve(credentialName);

      if (credential === undefined || credential.trim() === "") {
        // Delivery is surfaced as auth_failed rather than retried forever: the
        // operator rotates the credential the same way they rotate every other.
        throw new NotificationProviderError(
          "auth_failed",
          `the credential store holds no entry named "${credentialName}"`,
        );
      }

      let response: Response;

      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: notification.title,
            body: notification.body,
            ...(notification.url === undefined ? {} : { url: notification.url }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        // A URL the safety module refuses is a destination the delivery path
        // cannot reach and should not retry, so it is surfaced as `not_found`
        // rather than thrown as a configuration error: the delivery path
        // branches only on the shared vocabulary, and a plain-HTTP endpoint
        // never reaches here because construction refuses it.
        if (cause instanceof BlockedUrlError) {
          throw new NotificationProviderError(
            "not_found",
            "the endpoint is not reachable under the URL-safety rules",
            undefined,
            { cause },
          );
        }

        throw new NotificationProviderError("timed_out", "the provider did not answer", undefined, {
          cause,
        });
      }

      if (response.status === 401 || response.status === 403) {
        throw new NotificationProviderError(
          "auth_failed",
          "the provider refused the credential",
          response.status,
        );
      }

      if (response.status === 404) {
        throw new NotificationProviderError(
          "not_found",
          "the webhook destination does not exist",
          response.status,
        );
      }

      if (response.status === 429) {
        throw new NotificationProviderError(
          "rate_limited",
          "the provider is refusing deliveries for now",
          response.status,
        );
      }

      if (!response.ok) {
        throw new NotificationProviderError(
          "timed_out",
          `the provider answered HTTP ${response.status}`,
          response.status,
        );
      }

      return readReceipt(response);
    },
  };
}
