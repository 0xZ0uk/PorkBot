import type {
  CredentialStore,
  WebAccessProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchRequest,
  WebSearchResult,
} from "@porkbot/adapter-kit";
import { BlockedUrlError, safeFetch } from "@porkbot/effect";
import type { SafeFetch } from "@porkbot/effect";
import {
  statusFailure,
  WebAccessConfigurationError,
  WebAccessProviderError,
} from "./web-access-errors.ts";
import {
  decodeBounded,
  DEFAULT_TIMEOUT_MS,
  resolveLimit,
  resolveMaxBytes,
} from "./web-access-wire.ts";

/**
 * The one real web-access provider: every fetch is an HTTPS GET through the
 * URL-safety module, and search speaks one documented JSON contract so any
 * service that ranks the web can sit behind it:
 *
 *   GET <the model's url>   → the page itself; a 2xx body is the response,
 *                             truncated at the request's byte budget
 *
 *   POST {endpoint}/search
 *   { "query": "…", "limit": 5 }
 *   200 → { "results": [ { "title", "url", "snippet" } ] }
 *
 * The transport is injected and defaults to `safeFetch` (PRD decision 23), so
 * a shipped deployment dials only HTTPS, refuses embedded credentials, and
 * checks the address on the connection rather than on the string; the offline
 * wire test injects a plain fetch to reach its loopback server. The search key
 * is resolved by name from the injected `CredentialStore` on every call, never
 * read from the environment and never a constructor argument, which keeps
 * rotation a store concern and the secret out of adapter configuration.
 *
 * Address safety is not repeated here. A destination the URL-safety rules
 * refuse is classified `auth_failed` — a refusal the run asks about rather
 * than retries — and the response body is never quoted in an error, because a
 * destination is free to echo whatever it was sent. Redirects are followed
 * only within the host the caller named: the run's allowlist authorized that
 * host, so a hop to another host is refused rather than silently reached.
 */

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 10;

export interface HttpWebAccessSearchOptions {
  /**
   * Absolute base URL that accepts the documented search contract, for example
   * `https://search.example.invalid/v1`. Embedded credentials are rejected:
   * the key belongs in the credential store.
   */
  readonly endpoint: string;
  /** The name the search key is stored under in the credential store. */
  readonly credentialName: string;
  /** Resolves the search key; the parameter is never read from the environment here. */
  readonly credentials: CredentialStore;
}

export interface HttpWebAccessOptions {
  /**
   * Transport seam for the offline wire test, which speaks plain HTTP on
   * loopback; defaults to the URL-safety module's `safeFetch`, so a shipped
   * deployment only ever dials an HTTPS destination whose resolved address is
   * public (PRD decision 23).
   */
  readonly fetch?: SafeFetch;
  /** Per-request budget; defaults to ten seconds. */
  readonly timeoutMs?: number;
  /** Body budget a request that names none gets; defaults to 1 MiB. */
  readonly maxBytes?: number;
  /** Omitted means this provider serves fetch only and refuses every search. */
  readonly search?: HttpWebAccessSearchOptions;
}

function resolveTimeout(raw: number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (!Number.isFinite(raw) || raw <= 0) {
    throw new WebAccessConfigurationError(
      "timeoutMs",
      "invalid",
      "Expected a positive number of milliseconds.",
    );
  }

  return raw;
}

function resolveEndpoint(raw: string, allowInsecureHttp: boolean): string {
  const endpoint = raw.trim();

  if (endpoint === "") {
    throw new WebAccessConfigurationError(
      "endpoint",
      "missing",
      "Set the search API base URL, for example https://search.example.invalid/v1.",
    );
  }

  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    throw new WebAccessConfigurationError(
      "endpoint",
      "invalid",
      "Expected an absolute https URL, for example https://search.example.invalid/v1.",
    );
  }

  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new WebAccessConfigurationError(
      "endpoint",
      "invalid",
      `The search credential is sent as a bearer token, so the endpoint must be https; got "${url.protocol}" instead.`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new WebAccessConfigurationError(
      "endpoint",
      "invalid",
      "Remove the credentials from the URL and store the key in the credential store.",
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new WebAccessConfigurationError(
      "endpoint",
      "invalid",
      "Expected a base URL without a query string or fragment; search appends its own path.",
    );
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function resolveCredentialName(raw: string): string {
  const name = raw.trim();

  if (name === "") {
    throw new WebAccessConfigurationError(
      "credential",
      "missing",
      "Name the credential store entry that holds the search API key.",
    );
  }

  return name;
}

function normalizeRequestUrl(raw: string): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }

  try {
    return new URL(raw).href;
  } catch {
    return undefined;
  }
}

/** A body read under a budget, with whether the budget cut it short. */
interface BoundedBody {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Reads at most `budget` bytes of a response body. The stream is cancelled as
 * soon as the budget is met, so a page that exceeds it is never buffered
 * whole; a decode that cuts a multi-byte character is expected, not an error.
 */
async function readBounded(response: Response, budget: number): Promise<BoundedBody> {
  const stream = response.body;

  if (stream === null) {
    return { text: "", truncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const remaining = budget - total;

      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;

      if (slice.byteLength < value.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { text: decodeBounded(chunks, total), truncated };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readSearchResult(value: unknown): WebSearchResult {
  const unusable = (): never => {
    throw new WebAccessProviderError(
      "timed_out",
      "the search response did not match the documented contract",
    );
  };

  if (!isRecord(value)) {
    return unusable();
  }

  const { title, url, snippet } = value;

  if (typeof title !== "string" || typeof url !== "string" || typeof snippet !== "string") {
    return unusable();
  }

  if (url.trim() === "") {
    return unusable();
  }

  return { title, url, snippet };
}

export function createHttpWebAccessProvider(options: HttpWebAccessOptions = {}): WebAccessProvider {
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const defaultMaxBytes = resolveMaxBytes(options.maxBytes);
  const fetchImpl = options.fetch ?? safeFetch;
  // A test transport reaches its own loopback server, so http is allowed only
  // when one is injected; a shipped configuration sends its bearer token to
  // https alone.
  const allowInsecureHttp = options.fetch !== undefined;
  const searchOptions =
    options.search === undefined
      ? undefined
      : {
          endpoint: resolveEndpoint(options.search.endpoint, allowInsecureHttp),
          credentialName: resolveCredentialName(options.search.credentialName),
          credentials: options.search.credentials,
        };

  /** Releases a response nobody will read, so the connection is not held open. */
  function discard(response: Response): void {
    void response.body?.cancel().catch(() => undefined);
  }

  function transportFailure(cause: unknown): WebAccessProviderError {
    if (cause instanceof BlockedUrlError) {
      return new WebAccessProviderError(
        "auth_failed",
        "the URL-safety rules refused the destination",
        undefined,
        { cause },
      );
    }

    return new WebAccessProviderError("timed_out", "the destination did not answer", undefined, {
      cause,
    });
  }

  /**
   * Follows redirects with one rule the seam owns: a redirect may not change
   * the host. The run's allowlist authorized the host, so a hop to another
   * host is a destination nobody approved; the caller adds that host to the
   * allowlist and fetches it directly. The address-safety rules still run on
   * every hop because every hop is a fresh `safeFetch` call.
   */
  async function followRedirects(startUrl: string): Promise<{ response: Response; url: string }> {
    const startHost = new URL(startUrl).hostname.toLowerCase();
    const signal = AbortSignal.timeout(timeoutMs);
    let current = startUrl;

    for (let hops = 0; ; hops += 1) {
      let response: Response;

      try {
        response = await fetchImpl(current, {
          method: "GET",
          headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
          redirect: "manual",
          signal,
        });
      } catch (cause) {
        throw transportFailure(cause);
      }

      const location = response.headers.get("location");

      if (!redirectStatuses.has(response.status) || location === null) {
        return { response, url: current };
      }

      let next: URL;

      try {
        next = new URL(location, current);
      } catch {
        discard(response);
        throw new WebAccessProviderError(
          "timed_out",
          "the destination redirected to an invalid URL",
          response.status,
        );
      }

      if (next.hostname.toLowerCase() !== startHost) {
        discard(response);
        throw new WebAccessProviderError(
          "auth_failed",
          "the destination redirected to another host; add that host to the run's allowlist and fetch it directly",
          response.status,
        );
      }

      if (hops >= maxRedirects) {
        discard(response);
        throw new WebAccessProviderError(
          "timed_out",
          "the destination redirected too many times",
          response.status,
        );
      }

      discard(response);
      current = next.href;
    }
  }

  return {
    async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
      const url = normalizeRequestUrl(request.url);

      if (url === undefined) {
        throw new WebAccessProviderError("not_found", "the URL is not an absolute URL");
      }

      const budget = resolveMaxBytes(request.maxBytes ?? defaultMaxBytes);
      const { response, url: finalUrl } = await followRedirects(url);

      const failure = statusFailure(response.status);

      if (failure !== undefined) {
        discard(response);
        throw new WebAccessProviderError(failure.kind, failure.detail, response.status);
      }

      let body: BoundedBody;

      try {
        body = await readBounded(response, budget);
      } catch (cause) {
        throw new WebAccessProviderError(
          "timed_out",
          "the response body did not finish",
          response.status,
          { cause },
        );
      }

      return {
        url: finalUrl,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body: body.text,
      };
    },

    async search(request: WebSearchRequest): Promise<readonly WebSearchResult[]> {
      if (searchOptions === undefined) {
        throw new WebAccessProviderError(
          "auth_failed",
          "no search endpoint is configured for this provider",
        );
      }

      const credential = await searchOptions.credentials.resolve(searchOptions.credentialName);

      if (credential === undefined || credential.trim() === "") {
        throw new WebAccessProviderError(
          "auth_failed",
          `the credential store holds no entry named "${searchOptions.credentialName}"`,
        );
      }

      const limit = resolveLimit(request.limit);

      let response: Response;

      try {
        response = await fetchImpl(`${searchOptions.endpoint}/search`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: request.query,
            ...(limit === undefined ? {} : { limit }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw transportFailure(cause);
      }

      const failure = statusFailure(response.status);

      if (failure !== undefined) {
        discard(response);
        throw new WebAccessProviderError(failure.kind, failure.detail, response.status);
      }

      let payload: unknown;

      try {
        const body = await readBounded(response, defaultMaxBytes);

        if (body.truncated) {
          throw new WebAccessProviderError(
            "timed_out",
            "the search response exceeded the provider's budget",
            response.status,
          );
        }

        payload = JSON.parse(body.text);
      } catch (error) {
        if (error instanceof WebAccessProviderError) {
          throw error;
        }

        throw new WebAccessProviderError("timed_out", "the search response was not JSON");
      }

      if (!isRecord(payload) || !Array.isArray(payload["results"])) {
        throw new WebAccessProviderError(
          "timed_out",
          "the search response did not match the documented contract",
        );
      }

      // A provider that returns more than it was asked for is cut to the
      // request's own limit, the way recall clamps a provider's answer.
      const results = payload["results"].map(readSearchResult);

      return limit === undefined ? results : results.slice(0, limit);
    },
  };
}
