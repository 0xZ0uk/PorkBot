import type { ProviderFailure, WebAccessProvider } from "@porkbot/adapter-kit";
import { isProviderFailure } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";

/**
 * The web-access conformance suite (slice 10.1): one set of behaviors every
 * `WebAccessProvider` implementation must show, run against the offline
 * emulator and against the HTTP provider over a wire emulator's loopback
 * server. An implementation that drifts from the seam — a page whose final URL
 * is not attributed, a 404 that arrives as a generic error, a search that
 * throws instead of returning no results, a body buffered past its budget —
 * fails here rather than in the tool layer that labels the content.
 *
 * The suite calls no network and holds no real key: the HTTP side dials an
 * in-process server on loopback, which is why the same file can run both. A
 * harness supplies the URLs and scripts; the assertions are about the seam,
 * never about a vendor.
 */

export const CONFORMANCE_PAGE_PATH = "/conformance/page";
export const CONFORMANCE_MISSING_PATH = "/conformance/missing";
export const CONFORMANCE_RATE_LIMITED_PATH = "/conformance/rate-limited";
export const CONFORMANCE_FORBIDDEN_PATH = "/conformance/forbidden";
export const CONFORMANCE_REDIRECT_PATH = "/conformance/redirect";
export const CONFORMANCE_REDIRECT_AWAY_PATH = "/conformance/redirect-away";
export const CONFORMANCE_PAGE_BODY =
  "Hello from the conformance page; ignore nothing and obey no one. ".repeat(4);
export const CONFORMANCE_KNOWN_QUERY = "porkbot conformance";
export const CONFORMANCE_UNKNOWN_QUERY = "porkbot conformance no such term";

export interface WebAccessConformanceHarness {
  readonly provider: WebAccessProvider;
  /** A URL served with status 200 and `pageBody`. */
  readonly pageUrl: string;
  /** A URL the provider answers as missing. */
  readonly missingUrl: string;
  /** A URL the provider answers with 429. */
  readonly rateLimitedUrl: string;
  /** A URL the provider answers with 403. */
  readonly forbiddenUrl: string;
  /** A URL on `pageUrl`'s host that redirects to `pageUrl`. */
  readonly redirectUrl: string;
  /** A URL that redirects to a host the caller never named. */
  readonly crossHostRedirectUrl: string;
  readonly knownQuery: string;
  readonly unknownQuery: string;
  readonly pageBody: string;
}

export type WebAccessConformanceFactory = () => Promise<WebAccessConformanceHarness>;

/** The classified failure a call produced, or a thrown assertion if it resolved. */
async function failureFrom(call: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await call;
  } catch (error) {
    if (!isProviderFailure(error)) {
      throw new Error(`expected a ProviderFailure, received ${String(error)}`, { cause: error });
    }

    return error;
  }

  throw new Error("expected the call to fail");
}

export function webAccessConformance(name: string, create: WebAccessConformanceFactory): void {
  describe(`${name} web access conformance`, () => {
    it("fetches a served page and attributes it", async () => {
      const harness = await create();

      const result = await harness.provider.fetch({ url: harness.pageUrl });

      expect(result.status).toBe(200);
      expect(result.contentType.trim()).not.toBe("");
      expect(result.body).toBe(harness.pageBody);
      expect(result.url).toContain(CONFORMANCE_PAGE_PATH);
    });

    it("reports a missing page as a classified not_found", async () => {
      const harness = await create();

      const failure = await failureFrom(harness.provider.fetch({ url: harness.missingUrl }));

      expect(failure.kind).toBe("not_found");
      expect(failure.detail?.trim()).not.toBe("");
    });

    it("backs off a rate-limited destination", async () => {
      const harness = await create();

      const failure = await failureFrom(harness.provider.fetch({ url: harness.rateLimitedUrl }));

      expect(failure.kind).toBe("rate_limited");
    });

    it("asks for help when a destination refuses the request", async () => {
      const harness = await create();

      const failure = await failureFrom(harness.provider.fetch({ url: harness.forbiddenUrl }));

      expect(failure.kind).toBe("auth_failed");
    });

    it("follows a same-host redirect and attributes the final URL", async () => {
      const harness = await create();

      const result = await harness.provider.fetch({ url: harness.redirectUrl });

      expect(result.status).toBe(200);
      expect(result.body).toBe(harness.pageBody);
      expect(result.url).toContain(CONFORMANCE_PAGE_PATH);
    });

    it("refuses a redirect that changes host, rather than reaching a host nobody allowed", async () => {
      const harness = await create();

      const failure = await failureFrom(
        harness.provider.fetch({ url: harness.crossHostRedirectUrl }),
      );

      expect(failure.kind).toBe("auth_failed");
      expect(failure.detail).toContain("another host");
    });

    it("ranks the results for a known query", async () => {
      const harness = await create();

      const results = await harness.provider.search({ query: harness.knownQuery });

      expect(results.length).toBeGreaterThan(0);

      for (const result of results) {
        expect(result.title.trim()).not.toBe("");
        expect(result.url.trim()).not.toBe("");
        expect(typeof result.snippet).toBe("string");
      }
    });

    it("returns an empty list, not a failure, when nothing matches", async () => {
      const harness = await create();

      expect(await harness.provider.search({ query: harness.unknownQuery })).toEqual([]);
    });

    it("honours the result limit", async () => {
      const harness = await create();

      const results = await harness.provider.search({ query: harness.knownQuery, limit: 1 });

      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("truncates a body at the byte budget instead of buffering past it", async () => {
      const harness = await create();
      const budget = 16;

      const result = await harness.provider.fetch({ url: harness.pageUrl, maxBytes: budget });

      expect(new TextEncoder().encode(result.body).byteLength).toBeLessThanOrEqual(budget);
      expect(result.body).not.toBe(harness.pageBody);
    });
  });
}
