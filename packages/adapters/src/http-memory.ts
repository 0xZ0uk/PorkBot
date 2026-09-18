import type {
  CredentialStore,
  MemoryEntry,
  MemoryMatch,
  MemoryProvider,
  MemorySearchRequest,
} from "@porkbot/adapter-kit";
import { BlockedUrlError, safeFetch } from "@porkbot/effect";
import type { SafeFetch } from "@porkbot/effect";
import { MemoryConfigurationError, MemoryProviderError } from "./memory-errors.ts";

/**
 * The one real memory provider: an HTTPS JSON API configured by URL and
 * credential name, like every other seam. It speaks this contract, so any
 * service that indexes documents and ranks them can sit behind it:
 *
 *   POST {endpoint}/index
 *   { "entries": [ { "botId", "documentId", "revision", "kind", "title", "content" } ] }
 *   any 2xx → the entries are indexed; the response body is not read
 *
 *   POST {endpoint}/forget
 *   { "botId", "documentIds": ["…"] }
 *   any 2xx → the documents are dropped; the response body is not read
 *
 *   POST {endpoint}/search
 *   { "botId", "text", "limit", "mode": "lexical" | "semantic" | "auto" }
 *   200 → { "matches": [ { "documentId", "revision", "title", "excerpt", "score", "mode" } ] }
 *
 * The key is never a constructor argument and never an environment read: it is
 * resolved by name from the injected `CredentialStore` on every call, which
 * keeps rotation a store concern and the secret out of adapter configuration.
 * Provider response bodies are never included in an error, because a provider
 * is free to echo the key it just rejected.
 *
 * Failures are classified with the shared vocabulary because recall degrades on
 * them: a refused credential is `auth_failed`, a quota is `rate_limited`, and a
 * transport failure, a timeout, a 5xx or a response that does not match the
 * contract is `timed_out`. The recall seam falls back to lexical search on any
 * of those, and reports the classification, so a misconfigured endpoint is
 * visible rather than a silently empty memory. Only the endpoint URL itself is
 * a configuration error: it is checked at construction, where the operator can
 * fix it.
 */

export interface HttpMemoryProviderOptions {
  /**
   * Absolute base URL that accepts the documented contract, for example
   * `https://memory.example.invalid/v1`. Embedded credentials are rejected:
   * the key belongs in the credential store.
   */
  readonly endpoint: string;
  /** The name the API key is stored under in the credential store. */
  readonly credentialName: string;
  /** Resolves the API key; the parameter is never read from the environment here. */
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

function resolveEndpoint(raw: string): string {
  const endpoint = raw.trim();

  if (endpoint === "") {
    throw new MemoryConfigurationError(
      "endpoint",
      "missing",
      "Set the provider's API base URL, for example https://memory.example.invalid/v1.",
    );
  }

  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    throw new MemoryConfigurationError(
      "endpoint",
      "invalid",
      "Expected an absolute http(s) URL, for example https://memory.example.invalid/v1.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MemoryConfigurationError(
      "endpoint",
      "invalid",
      `Expected an http(s) URL, got "${url.protocol}" instead.`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new MemoryConfigurationError(
      "endpoint",
      "invalid",
      "Remove the credentials from the URL and store the key in the credential store.",
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new MemoryConfigurationError(
      "endpoint",
      "invalid",
      "Expected a base URL without a query string or fragment; the operations append their own path.",
    );
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function resolveCredentialName(raw: string): string {
  const name = raw.trim();

  if (name === "") {
    throw new MemoryConfigurationError(
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
    throw new MemoryConfigurationError(
      "timeoutMs",
      "invalid",
      "Expected a positive number of milliseconds.",
    );
  }

  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readMatch(value: unknown): MemoryMatch {
  const unusable = (): never => {
    throw new MemoryProviderError(
      "timed_out",
      "the search response did not match the documented contract",
    );
  };

  if (!isRecord(value)) {
    return unusable();
  }

  const { documentId, revision, title, excerpt, score, mode } = value;

  if (typeof documentId !== "string" || documentId.trim() === "") {
    return unusable();
  }

  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    return unusable();
  }

  if (typeof title !== "string" || typeof excerpt !== "string") {
    return unusable();
  }

  if (typeof score !== "number" || !Number.isFinite(score)) {
    return unusable();
  }

  if (mode !== "lexical" && mode !== "semantic") {
    return unusable();
  }

  return { documentId, revision, title, excerpt, score, mode };
}

export function createHttpMemoryProvider(options: HttpMemoryProviderOptions): MemoryProvider {
  const endpoint = resolveEndpoint(options.endpoint);
  const credentialName = resolveCredentialName(options.credentialName);
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const fetchImpl = options.fetch ?? safeFetch;

  async function post(path: string, payload: unknown): Promise<Response> {
    const credential = await options.credentials.resolve(credentialName);

    if (credential === undefined || credential.trim() === "") {
      // Recall degrades on this like any other refusal: the provider cannot be
      // reached, so the caller falls back to lexical matching.
      throw new MemoryProviderError(
        "auth_failed",
        `the credential store holds no entry named "${credentialName}"`,
      );
    }

    let response: Response;

    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // A URL the safety module refuses is unreachable like any other
      // provider outage: recall degrades and the operator sees the classified
      // failure, while a syntactically bad endpoint was already rejected at
      // construction.
      if (cause instanceof BlockedUrlError) {
        throw new MemoryProviderError(
          "timed_out",
          "the endpoint is not reachable under the URL-safety rules",
          undefined,
          { cause },
        );
      }

      throw new MemoryProviderError("timed_out", "the provider did not answer", undefined, {
        cause,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new MemoryProviderError(
        "auth_failed",
        "the provider refused the credential",
        response.status,
      );
    }

    if (response.status === 429) {
      throw new MemoryProviderError(
        "rate_limited",
        "the provider is refusing queries for now",
        response.status,
      );
    }

    if (!response.ok) {
      throw new MemoryProviderError(
        "timed_out",
        `the provider answered HTTP ${response.status}`,
        response.status,
      );
    }

    return response;
  }

  return {
    async index(entries: readonly MemoryEntry[]): Promise<void> {
      await post("/index", { entries });
    },

    async forget(botId: string, documentIds: readonly string[]): Promise<void> {
      await post("/forget", { botId, documentIds });
    },

    async search(request: MemorySearchRequest): Promise<readonly MemoryMatch[]> {
      const response = await post("/search", {
        botId: request.botId,
        text: request.text,
        limit: request.limit,
        mode: request.mode ?? "auto",
      });

      let payload: unknown;

      try {
        payload = await response.json();
      } catch {
        throw new MemoryProviderError("timed_out", "the search response was not JSON");
      }

      if (!isRecord(payload) || !Array.isArray(payload["matches"])) {
        throw new MemoryProviderError(
          "timed_out",
          "the search response did not match the documented contract",
        );
      }

      return payload["matches"].map(readMatch);
    },
  };
}
