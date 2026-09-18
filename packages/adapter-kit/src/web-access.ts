import type { FailureMapping } from "./failures.ts";

/**
 * The web access seam: fetching a URL and searching the web (PRD decision 23;
 * stories 32, 40; slices 4.6, 6.9, 10.1).
 *
 * The agent's window on the public web is one interface, so the egress rules
 * sit in one place: every implementation sends every request through the
 * URL-safety module (slice 4.6) — HTTPS only, no embedded credentials, no
 * private, link-local or metadata addresses, checked against the address
 * actually connected to. The offline emulator (slice 6.9) serves scripted
 * pages and results through the same interface, so the first end-to-end run
 * searches and fetches with no network; the real provider (slice 10.1) is
 * configured by URL and credential name and lands with the ingestion rules
 * that label its output untrusted.
 *
 * Whatever a fetch or a search returns is untrusted data. This seam says
 * nothing about instructions: labelling the content and keeping it out of the
 * instruction channel belongs to the tool layer that consumes it (slice 10.1).
 *
 * Failure mapping: a provider raises an error that implements
 * `ProviderFailure`, classified by the `failureMapping` table below. A tool
 * reports the kind back to the model so it can adapt; an approval gate decides
 * whether the destination was allowed at all before the request is made.
 */

export interface WebFetchRequest {
  readonly url: string;
  /** Body budget; a response that exceeds it is truncated at the boundary, never buffered whole. */
  readonly maxBytes?: number;
}

export interface WebFetchResult {
  /** The URL after redirects, so a caller can attribute the content it got. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  /** Response text, decoded by the provider; the caller labels it untrusted before use. */
  readonly body: string;
}

export interface WebSearchRequest {
  readonly query: string;
  readonly limit?: number;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebAccessProvider {
  /** Fetch one URL. A destination the run's allowlist rejects fails before the request is made. */
  fetch(request: WebFetchRequest): Promise<WebFetchResult>;
  /** Rank web results for a query. No results is an empty list, not a failure. */
  search(request: WebSearchRequest): Promise<readonly WebSearchResult[]>;
}

export const failureMapping: FailureMapping = {
  gone: "Not produced: every fetch is a fresh request; a URL that answers 404 today is `not_found` whether or not it answered yesterday.",
  not_found:
    "The resource does not exist (HTTP 404/410); a search that matches nothing is an empty list rather than a failure.",
  rate_limited:
    "A site or the search provider refuses work (HTTP 429); the tool tells the model to back off instead of hammering the destination.",
  timed_out: "The fetch or search exceeded its budget, including a body that stalls mid-stream.",
  auth_failed:
    "The configured search credential is missing or refused, or a destination answers 401/403; the run asks for help rather than retrying.",
};
