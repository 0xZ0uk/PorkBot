import type {
  ProviderFailureKind,
  WebAccessProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchRequest,
  WebSearchResult,
} from "@porkbot/adapter-kit";
import { statusFailure, WebAccessProviderError } from "./web-access-errors.ts";
import { decodeBounded, resolveLimit, resolveMaxBytes } from "./web-access-wire.ts";

/**
 * The offline web access provider: scripted pages and search results with no
 * network, no key and no clock. It is what the whole product runs on with no
 * provider configured, and it is the surface the tool layer's labelling and
 * egress rules are exercised against.
 *
 * Scripts are data, and the provider is deterministic: the same served page
 * produces the same result, search results come back in the order they were
 * scripted, and requests are recorded for assertions by position. A page is
 * keyed by its normalized URL, so `https://example.com` and
 * `https://example.com/` name the same page. An unserved URL is the seam's
 * `not_found`, and `failNext` injects one classified failure for the next call
 * — fetch or search — so lifecycle code that branches on the shared vocabulary
 * is testable offline.
 *
 * The emulator is part of the product, not a test double: the tool layer labels
 * whatever this returns exactly as it labels the HTTP provider's answer.
 */

export interface EmulatedPage {
  /** Absolute URL the page is served at, as a caller would request it. */
  readonly url: string;
  readonly body: string;
  /** Defaults to 200. */
  readonly status?: number | undefined;
  /** Defaults to `text/html; charset=utf-8`. */
  readonly contentType?: string | undefined;
  /**
   * Serve this URL as a redirect to another absolute URL. Only same-host
   * targets are reachable; a cross-host target is refused the same way the
   * HTTP provider refuses one.
   */
  readonly redirectTo?: string | undefined;
}

export interface EmulatedFailure {
  readonly kind: ProviderFailureKind;
  readonly detail?: string | undefined;
  readonly status?: number | undefined;
}

const DEFAULT_CONTENT_TYPE = "text/html; charset=utf-8";
const MAX_REDIRECTS = 10;

function normalizeUrl(url: string): string | undefined {
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}

function truncateToBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);

  if (bytes.byteLength <= maxBytes) {
    return text;
  }

  return decodeBounded([bytes.subarray(0, maxBytes)], maxBytes);
}

export class WebAccessEmulator implements WebAccessProvider {
  readonly #pages = new Map<string, EmulatedPage>();
  readonly #searchResults = new Map<string, readonly WebSearchResult[]>();
  readonly #fetches: WebFetchRequest[] = [];
  readonly #searches: WebSearchRequest[] = [];
  #failure: EmulatedFailure | undefined;

  /** Every fetch request received, oldest first. */
  get requests(): readonly WebFetchRequest[] {
    return this.#fetches;
  }

  /** Every search request received, oldest first. */
  get searches(): readonly WebSearchRequest[] {
    return this.#searches;
  }

  /** Serve one page; the last registration for a URL wins. */
  serve(page: EmulatedPage): this {
    const url = normalizeUrl(page.url);

    if (url === undefined) {
      throw new RangeError(`serve needs an absolute URL, received "${page.url}"`);
    }

    this.#pages.set(url, { ...page, url });
    return this;
  }

  /** Script the results one query ranks; the last registration wins. */
  answer(query: string, results: readonly WebSearchResult[]): this {
    this.#searchResults.set(
      query,
      results.map((result) => ({ ...result })),
    );
    return this;
  }

  /** Make the next call — fetch or search — fail with this classification. */
  failNext(failure: EmulatedFailure): this {
    this.#failure = { ...failure };
    return this;
  }

  /** The most recent fetch request, or `undefined` when none arrived. */
  lastRequest(): WebFetchRequest | undefined {
    return this.#fetches.at(-1);
  }

  /** The most recent search request, or `undefined` when none arrived. */
  lastSearch(): WebSearchRequest | undefined {
    return this.#searches.at(-1);
  }

  /** Forget pages, scripts, failures and recorded requests, for the next test. */
  clear(): void {
    this.#pages.clear();
    this.#searchResults.clear();
    this.#fetches.length = 0;
    this.#searches.length = 0;
    this.#failure = undefined;
  }

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    this.#fetches.push({ ...request });

    const injected = this.#takeFailure();

    if (injected !== undefined) {
      throw injected;
    }

    const url = normalizeUrl(request.url);

    if (url === undefined) {
      throw new WebAccessProviderError("not_found", "the URL is not an absolute URL");
    }

    const startHost = new URL(url).hostname.toLowerCase();
    let current = url;

    // A redirect may not change the host: the run's allowlist authorized the
    // host the caller named, so a hop elsewhere is refused, exactly as the
    // HTTP provider refuses one.
    for (let hops = 0; ; hops += 1) {
      const page = this.#pages.get(current);

      if (page === undefined) {
        throw new WebAccessProviderError("not_found", "the destination does not exist");
      }

      if (page.redirectTo !== undefined) {
        const target = normalizeUrl(page.redirectTo);

        if (target === undefined) {
          throw new WebAccessProviderError(
            "timed_out",
            "the destination redirected to an invalid URL",
          );
        }

        if (new URL(target).hostname.toLowerCase() !== startHost) {
          throw new WebAccessProviderError(
            "auth_failed",
            "the destination redirected to another host; add that host to the run's allowlist and fetch it directly",
            302,
          );
        }

        if (hops >= MAX_REDIRECTS) {
          throw new WebAccessProviderError(
            "timed_out",
            "the destination redirected too many times",
            302,
          );
        }

        current = target;
        continue;
      }

      const status = page.status ?? 200;
      const failure = statusFailure(status);

      if (failure !== undefined) {
        throw new WebAccessProviderError(failure.kind, failure.detail, status);
      }

      return {
        url: current,
        status,
        contentType: page.contentType ?? DEFAULT_CONTENT_TYPE,
        body: truncateToBytes(page.body, resolveMaxBytes(request.maxBytes)),
      };
    }
  }

  async search(request: WebSearchRequest): Promise<readonly WebSearchResult[]> {
    this.#searches.push({ ...request });

    const injected = this.#takeFailure();

    if (injected !== undefined) {
      throw injected;
    }

    const scripted = this.#searchResults.get(request.query) ?? [];
    const limit = resolveLimit(request.limit) ?? scripted.length;

    return scripted.slice(0, limit).map((result) => ({ ...result }));
  }

  #takeFailure(): WebAccessProviderError | undefined {
    if (this.#failure === undefined) {
      return undefined;
    }

    const { kind, detail, status } = this.#failure;
    this.#failure = undefined;

    return new WebAccessProviderError(kind, detail ?? "scripted failure", status);
  }
}
