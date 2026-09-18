import { describe, expect, it } from "vitest";
import type { ProviderFailure } from "@porkbot/adapter-kit";
import { WebAccessConfigurationError, WebAccessProviderError } from "./web-access-errors.ts";
import { WebAccessEmulator } from "./web-access-emulator.ts";
import {
  CONFORMANCE_FORBIDDEN_PATH,
  CONFORMANCE_KNOWN_QUERY,
  CONFORMANCE_MISSING_PATH,
  CONFORMANCE_PAGE_BODY,
  CONFORMANCE_PAGE_PATH,
  CONFORMANCE_RATE_LIMITED_PATH,
  CONFORMANCE_REDIRECT_AWAY_PATH,
  CONFORMANCE_REDIRECT_PATH,
  CONFORMANCE_UNKNOWN_QUERY,
  webAccessConformance,
} from "./web-access-conformance.ts";
import type { WebAccessConformanceHarness } from "./web-access-conformance.ts";

/**
 * The emulator's own behaviour, beyond the seam all implementations share: URLs
 * are keyed by their normalized form, requests and searches are recorded for
 * assertions by position, a scripted failure fires exactly once, and a budget
 * is honoured in bytes rather than characters.
 */

const base = "https://pages.example.invalid";

function conformanceHarness(): Promise<WebAccessConformanceHarness> {
  const emulator = new WebAccessEmulator()
    .serve({ url: `${base}${CONFORMANCE_PAGE_PATH}`, body: CONFORMANCE_PAGE_BODY })
    .serve({ url: `${base}${CONFORMANCE_RATE_LIMITED_PATH}`, status: 429, body: "" })
    .serve({ url: `${base}${CONFORMANCE_FORBIDDEN_PATH}`, status: 403, body: "" })
    .serve({
      url: `${base}${CONFORMANCE_REDIRECT_PATH}`,
      redirectTo: `${base}${CONFORMANCE_PAGE_PATH}`,
      body: "",
    })
    .serve({
      url: `${base}${CONFORMANCE_REDIRECT_AWAY_PATH}`,
      redirectTo: "https://attacker.invalid/lure",
      body: "",
    })
    .answer(CONFORMANCE_KNOWN_QUERY, [
      {
        title: "PorkBot conformance",
        url: "https://pages.example.invalid/result-1",
        snippet: "the first result",
      },
      {
        title: "A second result",
        url: "https://pages.example.invalid/result-2",
        snippet: "the second result",
      },
    ]);

  return Promise.resolve({
    provider: emulator,
    pageUrl: `${base}${CONFORMANCE_PAGE_PATH}`,
    missingUrl: `${base}${CONFORMANCE_MISSING_PATH}`,
    rateLimitedUrl: `${base}${CONFORMANCE_RATE_LIMITED_PATH}`,
    forbiddenUrl: `${base}${CONFORMANCE_FORBIDDEN_PATH}`,
    redirectUrl: `${base}${CONFORMANCE_REDIRECT_PATH}`,
    crossHostRedirectUrl: `${base}${CONFORMANCE_REDIRECT_AWAY_PATH}`,
    knownQuery: CONFORMANCE_KNOWN_QUERY,
    unknownQuery: CONFORMANCE_UNKNOWN_QUERY,
    pageBody: CONFORMANCE_PAGE_BODY,
  });
}

webAccessConformance("WebAccessEmulator", conformanceHarness);

async function failureFrom(call: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await call;
  } catch (error) {
    return error as ProviderFailure;
  }

  throw new Error("expected the call to fail");
}

describe("WebAccessEmulator scripting", () => {
  it("keys pages by their normalized URL", async () => {
    const emulator = new WebAccessEmulator().serve({
      url: "https://Page.Example.Invalid:443",
      body: "normalized",
    });

    const result = await emulator.fetch({ url: "https://page.example.invalid/" });

    expect(result.body).toBe("normalized");
    expect(result.url).toBe("https://page.example.invalid/");
  });

  it("records fetch and search requests for assertion by position", async () => {
    const emulator = new WebAccessEmulator()
      .serve({ url: `${base}/page`, body: "body" })
      .answer("query", []);

    await emulator.fetch({ url: `${base}/page`, maxBytes: 100 });
    await emulator.search({ query: "query", limit: 3 });

    expect(emulator.requests).toEqual([{ url: `${base}/page`, maxBytes: 100 }]);
    expect(emulator.searches).toEqual([{ query: "query", limit: 3 }]);
    expect(emulator.lastRequest()).toEqual({ url: `${base}/page`, maxBytes: 100 });
    expect(emulator.lastSearch()).toEqual({ query: "query", limit: 3 });
  });

  it("clears pages, scripts, failures and records", async () => {
    const emulator = new WebAccessEmulator().serve({ url: `${base}/page`, body: "body" });
    await emulator.fetch({ url: `${base}/page` });

    emulator.clear();

    expect(emulator.requests).toEqual([]);
    await expect(emulator.fetch({ url: `${base}/page` })).rejects.toBeInstanceOf(
      WebAccessProviderError,
    );
  });

  it("refuses to serve a URL that is not absolute", () => {
    expect(() => new WebAccessEmulator().serve({ url: "/relative", body: "x" })).toThrow(
      RangeError,
    );
  });

  it("injects one classified failure for the next call, fetch or search", async () => {
    const emulator = new WebAccessEmulator().serve({ url: `${base}/page`, body: "body" });

    emulator.failNext({ kind: "rate_limited", detail: "slow down", status: 429 });

    const fetchFailure = await failureFrom(emulator.fetch({ url: `${base}/page` }));
    expect(fetchFailure.kind).toBe("rate_limited");
    expect(fetchFailure.detail).toBe("slow down");
    expect(fetchFailure).toBeInstanceOf(WebAccessProviderError);
    expect((fetchFailure as WebAccessProviderError).status).toBe(429);

    emulator.failNext({ kind: "auth_failed", detail: "refused" });

    const searchFailure = await failureFrom(emulator.search({ query: "anything" }));
    expect(searchFailure.kind).toBe("auth_failed");
    expect(searchFailure.detail).toBe("refused");

    emulator.failNext({ kind: "timed_out" });
    expect((await failureFrom(emulator.search({ query: "anything" }))).detail).toBe(
      "scripted failure",
    );

    const ok = await emulator.fetch({ url: `${base}/page` });
    expect(ok.body).toBe("body");
  });

  it("classifies served statuses with the shared vocabulary", async () => {
    const emulator = new WebAccessEmulator()
      .serve({ url: `${base}/gone`, status: 410, body: "" })
      .serve({ url: `${base}/unauthorized`, status: 401, body: "" })
      .serve({ url: `${base}/broken`, status: 500, body: "" });

    expect((await failureFrom(emulator.fetch({ url: `${base}/gone` }))).kind).toBe("not_found");
    expect((await failureFrom(emulator.fetch({ url: `${base}/unauthorized` }))).kind).toBe(
      "auth_failed",
    );
    expect((await failureFrom(emulator.fetch({ url: `${base}/broken` }))).kind).toBe("timed_out");
  });

  it("serves a caller-defined content type", async () => {
    const emulator = new WebAccessEmulator().serve({
      url: `${base}/data.json`,
      body: "{}",
      contentType: "application/json",
    });

    const result = await emulator.fetch({ url: `${base}/data.json` });

    expect(result.contentType).toBe("application/json");
  });

  it("truncates a body at a byte budget", async () => {
    const emulator = new WebAccessEmulator().serve({
      url: `${base}/page`,
      body: "a".repeat(64),
    });

    const result = await emulator.fetch({ url: `${base}/page`, maxBytes: 10 });

    expect(result.body).toBe("a".repeat(10));
  });

  it("refuses a non-positive budget and a non-positive limit", async () => {
    const emulator = new WebAccessEmulator().serve({ url: `${base}/page`, body: "body" });

    await expect(emulator.fetch({ url: `${base}/page`, maxBytes: 0 })).rejects.toBeInstanceOf(
      WebAccessConfigurationError,
    );
    await expect(emulator.search({ query: "q", limit: -1 })).rejects.toBeInstanceOf(
      WebAccessConfigurationError,
    );
  });

  it("refuses a redirect loop rather than following it forever", async () => {
    const emulator = new WebAccessEmulator()
      .serve({ url: `${base}/loop-a`, redirectTo: `${base}/loop-b`, body: "" })
      .serve({ url: `${base}/loop-b`, redirectTo: `${base}/loop-a`, body: "" });

    const failure = await failureFrom(emulator.fetch({ url: `${base}/loop-a` }));

    expect(failure.kind).toBe("timed_out");
    expect(failure.detail).toContain("too many times");
  });

  it("refuses a redirect to an invalid URL", async () => {
    const emulator = new WebAccessEmulator().serve({
      url: `${base}/bad-redirect`,
      redirectTo: "not a url",
      body: "",
    });

    const failure = await failureFrom(emulator.fetch({ url: `${base}/bad-redirect` }));

    expect(failure.kind).toBe("timed_out");
    expect(failure.detail).toContain("invalid URL");
  });

  it("ranks at most the requested number of results", async () => {
    const emulator = new WebAccessEmulator().answer("query", [
      { title: "one", url: `${base}/1`, snippet: "1" },
      { title: "two", url: `${base}/2`, snippet: "2" },
    ]);

    expect(await emulator.search({ query: "query", limit: 1 })).toHaveLength(1);
    expect(await emulator.search({ query: "query" })).toHaveLength(2);
  });
});
