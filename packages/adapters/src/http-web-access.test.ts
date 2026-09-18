import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ProviderFailure } from "@porkbot/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryCredentialStore } from "./credentials.ts";
import { createHttpWebAccessProvider } from "./http-web-access.ts";
import { WebAccessConfigurationError } from "./web-access-errors.ts";
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
 * The real web-access provider against a wire emulator: an in-process HTTP
 * server that speaks the documented contract. No network leaves the process,
 * but the requests the provider actually makes — method, path, headers and
 * JSON body — are what the assertions read, so this is the wire protocol
 * rather than a mock. The default transport is `safeFetch`; the harness injects
 * a plain fetch only to reach its own loopback server, and one test proves the
 * default still refuses a blocked address.
 */

const credentialName = "web-search-key";
const credentialValue = "test-search-key-not-real-0001";

interface RecordedRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Record<string, unknown>;
}

interface Wire {
  server: Server;
  origin: string;
  readonly requests: RecordedRequest[];
  /** When set, `/search` answers this status instead of results. */
  searchStatus: number | undefined;
  /** When true, `/search` answers a payload that does not match the contract. */
  malformedSearch: boolean;
}

const openServers: Server[] = [];

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || error === null) {
        resolve();
        return;
      }

      reject(error);
    });
    server.closeAllConnections();
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(close));
});

function respond(response: ServerResponse, status: number, body: string, type?: string): void {
  response.writeHead(status, type === undefined ? {} : { "content-type": type });
  response.end(body);
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  respond(response, status, JSON.stringify(payload), "application/json");
}

async function startWire(): Promise<Wire> {
  const requests: RecordedRequest[] = [];
  const wire: Wire = {
    server: undefined as unknown as Server,
    origin: "",
    requests,
    searchStatus: undefined,
    malformedSearch: false,
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

      requests.push({
        method: request.method,
        path,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });

      if (path === CONFORMANCE_PAGE_PATH) {
        respond(response, 200, CONFORMANCE_PAGE_BODY, "text/html; charset=utf-8");
        return;
      }

      if (path === CONFORMANCE_MISSING_PATH) {
        respond(response, 404, "");
        return;
      }

      if (path === CONFORMANCE_RATE_LIMITED_PATH) {
        respond(response, 429, "");
        return;
      }

      if (path === CONFORMANCE_FORBIDDEN_PATH) {
        respond(response, 403, "");
        return;
      }

      if (path === "/redirect" || path === CONFORMANCE_REDIRECT_PATH) {
        response.writeHead(302, { location: CONFORMANCE_PAGE_PATH });
        response.end();
        return;
      }

      if (path === CONFORMANCE_REDIRECT_AWAY_PATH) {
        response.writeHead(302, { location: "https://attacker.invalid/lure" });
        response.end();
        return;
      }

      if (path === "/echo-body") {
        respond(response, 500, "leaked-response-body-9f3a");
        return;
      }

      if (path === "/search") {
        if (wire.searchStatus !== undefined) {
          respond(response, wire.searchStatus, credentialValue);
          return;
        }

        if (wire.malformedSearch) {
          respondJson(response, 200, { results: "not an array" });
          return;
        }

        const query = raw === "" ? "" : (JSON.parse(raw) as { readonly query?: unknown }).query;

        if (query === CONFORMANCE_KNOWN_QUERY) {
          respondJson(response, 200, {
            results: [
              {
                title: "PorkBot conformance",
                url: `${wire.origin}/result-1`,
                snippet: "the first result",
              },
              {
                title: "A second result",
                url: `${wire.origin}/result-2`,
                snippet: "the second result",
              },
            ],
          });
          return;
        }

        respondJson(response, 200, { results: [] });
        return;
      }

      respond(response, 404, "");
    });
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  openServers.push(server);

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("the wire provider did not bind a TCP port");
  }

  wire.server = server;
  wire.origin = `http://127.0.0.1:${address.port}`;

  return wire;
}

function providerFor(wire: Wire) {
  return createHttpWebAccessProvider({
    fetch: globalThis.fetch,
    search: {
      endpoint: `${wire.origin}/`,
      credentialName,
      credentials: createMemoryCredentialStore([[credentialName, credentialValue]]),
    },
  });
}

async function conformanceHarness(): Promise<WebAccessConformanceHarness> {
  const wire = await startWire();

  return {
    provider: providerFor(wire),
    pageUrl: `${wire.origin}${CONFORMANCE_PAGE_PATH}`,
    missingUrl: `${wire.origin}${CONFORMANCE_MISSING_PATH}`,
    rateLimitedUrl: `${wire.origin}${CONFORMANCE_RATE_LIMITED_PATH}`,
    forbiddenUrl: `${wire.origin}${CONFORMANCE_FORBIDDEN_PATH}`,
    redirectUrl: `${wire.origin}${CONFORMANCE_REDIRECT_PATH}`,
    crossHostRedirectUrl: `${wire.origin}${CONFORMANCE_REDIRECT_AWAY_PATH}`,
    knownQuery: CONFORMANCE_KNOWN_QUERY,
    unknownQuery: CONFORMANCE_UNKNOWN_QUERY,
    pageBody: CONFORMANCE_PAGE_BODY,
  };
}

webAccessConformance("createHttpWebAccessProvider", conformanceHarness);

async function failureFrom(call: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await call;
  } catch (error) {
    return error as ProviderFailure;
  }

  throw new Error("expected the call to fail");
}

describe("the HTTP web access provider over the wire", () => {
  it("attributes the final URL after a redirect", async () => {
    const wire = await startWire();
    const provider = providerFor(wire);

    const result = await provider.fetch({ url: `${wire.origin}/redirect` });

    expect(result.url).toBe(`${wire.origin}${CONFORMANCE_PAGE_PATH}`);
    expect(result.body).toBe(CONFORMANCE_PAGE_BODY);
  });

  it("sends the documented search request with the resolved credential", async () => {
    const wire = await startWire();
    const provider = providerFor(wire);

    await provider.search({ query: CONFORMANCE_KNOWN_QUERY, limit: 2 });

    const request = wire.requests.at(-1);

    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/search");
    expect(request?.authorization).toBe(`Bearer ${credentialValue}`);
    expect(request?.contentType).toBe("application/json");
    expect(request?.body).toEqual({ query: CONFORMANCE_KNOWN_QUERY, limit: 2 });
  });

  it("omits the limit when the caller set none", async () => {
    const wire = await startWire();
    const provider = providerFor(wire);

    await provider.search({ query: "anything" });

    expect(wire.requests.at(-1)?.body).toEqual({ query: "anything" });
  });

  it("classifies a search refusal and a broken search response", async () => {
    const wire = await startWire();
    const provider = providerFor(wire);

    wire.searchStatus = 429;
    expect((await failureFrom(provider.search({ query: "q" }))).kind).toBe("rate_limited");

    wire.searchStatus = 500;
    expect((await failureFrom(provider.search({ query: "q" }))).kind).toBe("timed_out");
  });

  it("refuses a search response that does not match the contract", async () => {
    const wire = await startWire();
    const provider = providerFor(wire);

    wire.malformedSearch = true;

    expect((await failureFrom(provider.search({ query: "q" }))).kind).toBe("timed_out");
  });

  it("fails closed when search is not configured or the credential is missing", async () => {
    const wire = await startWire();

    const withoutSearch = createHttpWebAccessProvider({ fetch: globalThis.fetch });
    expect((await failureFrom(withoutSearch.search({ query: "q" }))).kind).toBe("auth_failed");

    const withoutCredential = createHttpWebAccessProvider({
      fetch: globalThis.fetch,
      search: {
        endpoint: wire.origin,
        credentialName,
        credentials: createMemoryCredentialStore(),
      },
    });
    expect((await failureFrom(withoutCredential.search({ query: "q" }))).kind).toBe("auth_failed");
  });

  it("refuses a request URL that is not absolute", async () => {
    const provider = createHttpWebAccessProvider({ fetch: globalThis.fetch });

    expect((await failureFrom(provider.fetch({ url: "/relative" }))).kind).toBe("not_found");
  });

  it("refuses every configuration that cannot be used", () => {
    const cases: readonly (() => unknown)[] = [
      () =>
        createHttpWebAccessProvider({
          search: { endpoint: "", credentialName, credentials: createMemoryCredentialStore() },
        }),
      () =>
        createHttpWebAccessProvider({
          search: {
            endpoint: "not a url",
            credentialName,
            credentials: createMemoryCredentialStore(),
          },
        }),
      () =>
        createHttpWebAccessProvider({
          search: {
            endpoint: "https://user:pass@search.example.invalid",
            credentialName,
            credentials: createMemoryCredentialStore(),
          },
        }),
      () =>
        createHttpWebAccessProvider({
          search: {
            endpoint: "https://search.example.invalid/v1?q=1",
            credentialName,
            credentials: createMemoryCredentialStore(),
          },
        }),
      () =>
        createHttpWebAccessProvider({
          search: {
            endpoint: "https://search.example.invalid",
            credentialName: "  ",
            credentials: createMemoryCredentialStore(),
          },
        }),
      () => createHttpWebAccessProvider({ timeoutMs: 0 }),
      () => createHttpWebAccessProvider({ maxBytes: -1 }),
    ];

    for (const build of cases) {
      expect(build).toThrow(WebAccessConfigurationError);
    }
  });

  it("never echoes a response body or a credential in an error", async () => {
    const wire = await startWire();
    const provider = providerFor(wire);

    const bodyFailure = await failureFrom(provider.fetch({ url: `${wire.origin}/echo-body` }));

    expect(JSON.stringify(bodyFailure)).not.toContain("leaked-response-body");

    wire.searchStatus = 401;
    const credentialFailure = await failureFrom(provider.search({ query: "q" }));

    expect(JSON.stringify(credentialFailure)).not.toContain(credentialValue);
  });

  it("still refuses a blocked address when no transport is injected", async () => {
    const provider = createHttpWebAccessProvider();

    expect((await failureFrom(provider.fetch({ url: "https://127.0.0.1/" }))).kind).toBe(
      "auth_failed",
    );
  });
});
