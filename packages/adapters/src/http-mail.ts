import type {
  CredentialStore,
  TransactionalEmailMessage,
  TransactionalEmailProvider,
  TransactionalEmailReceipt,
} from "@porkbot/adapter-kit";
import { CredentialMissingError } from "@porkbot/effect";
import { MailConfigurationError, MailDeliveryError } from "./mail-errors.ts";

/**
 * The one real transactional mail provider: an HTTPS JSON API configured by URL
 * and key. It speaks the wire contract Resend's `POST /emails` uses, so
 * `https://api.resend.com/emails` is a working endpoint and any gateway that
 * implements the same shape is one too:
 *
 *   POST {endpoint}
 *   Authorization: Bearer {key}
 *   Content-Type: application/json
 *   { "from": "…", "to": ["…"], "subject": "…", "text": "…", "html": "…"? }
 *
 *   any 2xx: { "id": "…" }
 *
 * The key is never a constructor argument and never an environment read: it is
 * resolved by name from the injected `CredentialStore` on every send, which is
 * what makes rotation a store concern and keeps the secret out of adapter
 * configuration. A name the store does not hold fails closed with
 * `CredentialMissingError` before any request is made; a key the provider
 * refuses (401/403) fails closed with `MailConfigurationError`. Provider
 * response bodies are never included in an error, because a provider is free to
 * echo the key it just rejected.
 */

export interface HttpMailProviderOptions {
  /**
   * Absolute API URL that accepts the documented contract, e.g.
   * `https://api.resend.com/emails`. Embedded credentials are rejected: the key
   * belongs in the credential store.
   */
  readonly endpoint: string;
  /** The sender the provider may send as; its domain must be verified there. */
  readonly from: string;
  /** The name the API key is stored under in the credential store. */
  readonly credentialName: string;
  /** Resolves the API key; the parameter is never read from the environment here. */
  readonly credentials: CredentialStore;
  /** Transport seam for tests; defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-request budget; defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

const defaultTimeoutMs = 10_000;

function resolveEndpoint(raw: string): URL {
  const endpoint = raw.trim();

  if (endpoint === "") {
    throw new MailConfigurationError(
      "endpoint",
      "missing",
      "Set the provider's API endpoint URL, for example https://api.resend.com/emails.",
    );
  }

  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    throw new MailConfigurationError(
      "endpoint",
      "invalid",
      "Expected an absolute http(s) URL, for example https://api.resend.com/emails.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MailConfigurationError(
      "endpoint",
      "invalid",
      `Expected an http(s) URL, got "${url.protocol}" instead.`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new MailConfigurationError(
      "endpoint",
      "invalid",
      "Remove the credentials from the URL and store the key in the credential store.",
    );
  }

  return url;
}

function resolveSender(raw: string): string {
  const from = raw.trim();

  if (from === "") {
    throw new MailConfigurationError(
      "sender",
      "missing",
      "Set the address the provider may send as.",
    );
  }

  if (!from.includes("@")) {
    throw new MailConfigurationError("sender", "invalid", "Expected an email address.");
  }

  return from;
}

function resolveCredentialName(raw: string): string {
  const name = raw.trim();

  if (name === "") {
    throw new MailConfigurationError(
      "credential",
      "missing",
      "Name the credential store entry that holds the provider API key.",
    );
  }

  return name;
}

function resolveTimeout(raw: number | undefined): number {
  if (raw === undefined) {
    return defaultTimeoutMs;
  }

  if (!Number.isFinite(raw) || raw <= 0) {
    throw new MailConfigurationError(
      "timeoutMs",
      "invalid",
      "Expected a positive number of milliseconds.",
    );
  }

  return raw;
}

async function readReceipt(response: Response): Promise<TransactionalEmailReceipt> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch (cause) {
    throw new MailDeliveryError({ status: response.status, retryable: false, cause });
  }

  const id =
    typeof payload === "object" && payload !== null && "id" in payload ? payload.id : undefined;

  if (typeof id !== "string" || id.trim() === "") {
    throw new MailDeliveryError({ status: response.status, retryable: false });
  }

  return { id };
}

export function createHttpMailProvider(
  options: HttpMailProviderOptions,
): TransactionalEmailProvider {
  const endpoint = resolveEndpoint(options.endpoint);
  const from = resolveSender(options.from);
  const credentialName = resolveCredentialName(options.credentialName);
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async send(message: TransactionalEmailMessage): Promise<TransactionalEmailReceipt> {
      const credential = await options.credentials.resolve(credentialName);

      if (credential === undefined || credential.trim() === "") {
        throw new CredentialMissingError(credentialName);
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
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html === undefined ? {} : { html: message.html }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new MailDeliveryError({ retryable: true, cause });
      }

      if (response.status === 401 || response.status === 403) {
        throw new MailConfigurationError(
          "credential",
          "rejected",
          "Replace the credential in the store; if it is current, check that the provider has verified the sender.",
        );
      }

      if (!response.ok) {
        throw new MailDeliveryError({
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      return readReceipt(response);
    },
  };
}
