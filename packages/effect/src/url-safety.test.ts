import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { ClientRequest, OutgoingHttpHeaders, RequestOptions } from "node:http";
import type { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCKED_ADDRESS_RULES,
  BlockedUrlError,
  assertAllowedUrl,
  createGuardedLookup,
  createSafeFetch,
  isBlockedAddress,
  safeFetch,
} from "./index.ts";
import type { GuardedLookup, ResolvedAddress } from "./index.ts";

/**
 * URL safety is a connection property, so the tests are about the resolver and
 * the socket, not about a string. A controlled resolver makes rebinding a
 * scripted fact, and a scripted `https.request` drives the redirect wire where
 * a real TLS server would need a certificate this repository does not ship.
 */

const openServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

function capturedError(run: () => unknown): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }

  return undefined;
}

async function startTrap(): Promise<{ port: number; connections: string[] }> {
  const connections: string[] = [];
  const trap = createServer((socket) => {
    connections.push("connected");
    socket.destroy();
  });

  await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve));
  openServers.push(trap);

  const address = trap.address();

  if (address === null || typeof address === "string") {
    throw new Error("the trap did not bind a TCP port");
  }

  return { port: address.port, connections };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the promise to reject");
}

function lookupAll(lookup: GuardedLookup, hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, address) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(Array.isArray(address) ? address : [{ address, family: 4 }]);
    });
  });
}

function lookupOne(lookup: GuardedLookup, hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: false }, (error, address) => {
      if (error !== null) {
        reject(error);
        return;
      }

      if (typeof address === "string") {
        resolve(address);
        return;
      }

      resolve(address[0]?.address ?? "");
    });
  });
}

describe("the blocked address rules", () => {
  it("blocks the base address of every rule in the one list", () => {
    for (const rule of BLOCKED_ADDRESS_RULES) {
      const network = rule.cidr.slice(0, rule.cidr.indexOf("/"));

      expect(isBlockedAddress(network), `${rule.cidr} (${rule.note}) was not blocked`).toBe(true);
    }
  });

  it("blocks private, loopback, link-local and metadata ranges", () => {
    const blocked = [
      "0.0.0.0",
      "10.1.2.3",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "172.20.1.1",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fd00:ec2::254",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
    ] as const;

    for (const address of blocked) {
      expect(isBlockedAddress(address), `${address} was not blocked`).toBe(true);
    }
  });

  it("blocks the addresses that IPv6 mappings and transitions embed", () => {
    const blocked = [
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::a00:1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::7f00:1",
      "2002:0a00:0001::",
      "2002:7f00:0001::",
    ] as const;

    for (const address of blocked) {
      expect(isBlockedAddress(address), `${address} was not blocked`).toBe(true);
    }
  });

  it("strips the zone before checking the address", () => {
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
  });

  it("allows public addresses, including public mappings", () => {
    const allowed = [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2002:5db8:d822::",
    ] as const;

    for (const address of allowed) {
      expect(isBlockedAddress(address), `${address} was blocked`).toBe(false);
    }
  });

  it("fails closed on anything that is not an address", () => {
    for (const address of ["", "not-an-ip", "10.0.0.999", "::gggg", "1.2.3"]) {
      expect(isBlockedAddress(address), `${address} was not blocked`).toBe(true);
    }
  });
});

describe("the URL pre-flight", () => {
  it("returns the parsed URL for an https URL without credentials", () => {
    const url = assertAllowedUrl("https://api.example.invalid/v1/models?limit=10");

    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("api.example.invalid");
  });

  it("refuses non-https schemes with a typed error", () => {
    for (const url of [
      "http://api.example.invalid/",
      "ftp://example.invalid/",
      "file:///etc/passwd",
    ]) {
      const error = capturedError(() => assertAllowedUrl(url));

      expect(error).toBeInstanceOf(BlockedUrlError);
      expect(error).toMatchObject({ reason: "insecure_scheme" });
    }
  });

  it("refuses embedded credentials without echoing them", () => {
    const error = capturedError(() =>
      assertAllowedUrl("https://operator:correct-horse@api.example.invalid/"),
    );

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({ reason: "embedded_credentials", host: "api.example.invalid" });
    expect(String((error as Error).message)).not.toContain("correct-horse");
  });

  it("refuses text that is not an absolute URL", () => {
    const error = capturedError(() => assertAllowedUrl("api.example.invalid/v1"));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({ reason: "invalid_url" });
  });

  it("refuses an IP-literal host the rules block, before any socket", () => {
    for (const url of [
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
      "https://[fd00:ec2::254]/",
    ]) {
      const error = capturedError(() => assertAllowedUrl(url));

      expect(error, `${url} was allowed`).toBeInstanceOf(BlockedUrlError);
      expect(error).toMatchObject({ reason: "blocked_address" });
    }
  });
});

describe("the guarded lookup", () => {
  it("re-resolves for every connection, so a rebound host is caught", async () => {
    const answers: ResolvedAddress[][] = [
      [{ address: "93.184.216.34", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }],
    ];
    let calls = 0;
    const lookup = createGuardedLookup({
      resolve: async () => answers[calls++] ?? [],
    });

    expect(await lookupAll(lookup, "rebind.example.invalid")).toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);

    const error = await rejection(lookupAll(lookup, "rebind.example.invalid"));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({
      reason: "blocked_address",
      host: "rebind.example.invalid",
      address: "127.0.0.1",
    });
    expect(calls).toBe(2);
  });

  it("refuses a host that resolves to a public and a private address together", async () => {
    const lookup = createGuardedLookup({
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    });

    const error = await rejection(lookupAll(lookup, "mixed.example.invalid"));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({ address: "10.0.0.5", reason: "blocked_address" });
  });

  it("answers the single-address form the resolver asks for", async () => {
    const lookup = createGuardedLookup({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(await lookupOne(lookup, "public.example.invalid")).toBe("93.184.216.34");
  });

  it("fails closed when the resolver answers with nothing", async () => {
    const lookup = createGuardedLookup({ resolve: async () => [] });

    const error = await rejection(lookupAll(lookup, "empty.example.invalid"));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({ reason: "blocked_address", address: undefined });
  });

  it("passes a resolver failure through as the network failure it is", async () => {
    const failure = new Error("getaddrinfo ENOTFOUND");
    const lookup = createGuardedLookup({
      resolve: async () => {
        throw failure;
      },
    });

    expect(await rejection(lookupAll(lookup, "missing.example.invalid"))).toBe(failure);
  });
});

describe("safeFetch", () => {
  it("refuses a plain-http URL before any request is built", async () => {
    const error = await rejection(safeFetch("http://api.example.invalid/"));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({ reason: "insecure_scheme" });
  });

  it("never dials an address the guard blocks", async () => {
    const trap = await startTrap();
    const fetchBlocked = createSafeFetch({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    const error = await rejection(fetchBlocked(`https://rebind.example.invalid:${trap.port}/`));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({ reason: "blocked_address", address: "127.0.0.1" });
    expect(trap.connections).toEqual([]);
  });

  it("never dials an IP literal the rules block, where no lookup runs", async () => {
    const trap = await startTrap();
    const error = await rejection(safeFetch(`https://127.0.0.1:${trap.port}/`));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({ reason: "blocked_address", address: "127.0.0.1" });
    expect(trap.connections).toEqual([]);
  });
});

interface ScriptedHop {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

interface RecordedHop {
  readonly url: string;
  readonly method: string | undefined;
  readonly authorization: string | undefined;
  readonly cookie: string | undefined;
}

/**
 * A scripted `https.request`: it runs the guarded lookup the fetcher passes in
 * — so every hop in a redirect test is still gated at the connection — then
 * answers with the next scripted hop instead of a socket.
 */
function scriptedRequest(script: ScriptedHop[], hops: RecordedHop[]): typeof httpsRequest {
  return ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const emitter = new EventEmitter() as unknown as ClientRequest;
    const authorization = requestHeader(options, "authorization");
    const cookie = requestHeader(options, "cookie");

    emitter.end = (() => {
      options.lookup?.(url.hostname, { all: true }, (error) => {
        if (error !== null) {
          emitter.emit("error", error);
          return;
        }

        const hop = script.shift() ?? { status: 200 };
        const response = Object.assign(Readable.from([Buffer.from(hop.body ?? "", "utf8")]), {
          statusCode: hop.status,
          statusMessage: "scripted",
          headers: hop.headers ?? {},
          url: url.href,
        }) as unknown as IncomingMessage;

        hops.push({
          url: url.href,
          method: options.method,
          authorization,
          cookie,
        });

        callback(response);
      });

      return emitter;
    }) as ClientRequest["end"];

    return emitter;
  }) as unknown as typeof httpsRequest;
}

const publicAnswer = async (): Promise<readonly ResolvedAddress[]> => [
  { address: "93.184.216.34", family: 4 },
];

function requestHeader(options: RequestOptions, name: string): string | undefined {
  const headers = options.headers;

  if (headers === undefined || Array.isArray(headers)) {
    return undefined;
  }

  const value = (headers as OutgoingHttpHeaders)[name];

  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || typeof value === "number") {
    return value === undefined ? undefined : String(value);
  }

  return value.join(", ");
}

describe("safeFetch redirects", () => {
  it("follows a redirect, reports where it landed and keeps same-origin headers", async () => {
    const hops: RecordedHop[] = [];
    const fetcher = createSafeFetch({
      resolve: publicAnswer,
      request: scriptedRequest(
        [
          { status: 302, headers: { location: "https://api.example.invalid/v2" } },
          { status: 200, headers: { "content-type": "text/plain" }, body: "final" },
        ],
        hops,
      ),
    });

    const response = await fetcher("https://api.example.invalid/v1", {
      headers: { authorization: "Bearer placeholder" },
    });

    expect(response.status).toBe(200);
    expect(response.redirected).toBe(true);
    expect(response.url).toBe("https://api.example.invalid/v2");
    expect(await response.text()).toBe("final");
    expect(hops.map((hop) => hop.url)).toEqual([
      "https://api.example.invalid/v1",
      "https://api.example.invalid/v2",
    ]);
    expect(hops.map((hop) => hop.authorization)).toEqual([
      "Bearer placeholder",
      "Bearer placeholder",
    ]);
  });

  it("drops credentials when a redirect changes origin", async () => {
    const hops: RecordedHop[] = [];
    const fetcher = createSafeFetch({
      resolve: publicAnswer,
      request: scriptedRequest(
        [
          { status: 302, headers: { location: "https://other.example.invalid/v2" } },
          { status: 200, body: "other" },
        ],
        hops,
      ),
    });

    await fetcher("https://api.example.invalid/v1", {
      headers: { authorization: "Bearer placeholder", cookie: "session=placeholder" },
    });

    expect(hops.map((hop) => hop.authorization)).toEqual(["Bearer placeholder", undefined]);
    expect(hops.map((hop) => hop.cookie)).toEqual(["session=placeholder", undefined]);
  });

  it("refuses a redirect that downgrades to http", async () => {
    const fetcher = createSafeFetch({
      resolve: publicAnswer,
      request: scriptedRequest(
        [{ status: 302, headers: { location: "http://api.example.invalid/downgrade" } }],
        [],
      ),
    });

    const error = await rejection(fetcher("https://api.example.invalid/v1"));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({ reason: "insecure_scheme", host: "api.example.invalid" });
  });

  it("checks the address of every redirect hop, so a redirect cannot rebind", async () => {
    const answers: ResolvedAddress[][] = [
      [{ address: "93.184.216.34", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
    ];
    let calls = 0;
    const fetcher = createSafeFetch({
      resolve: async () => answers[calls++] ?? [],
      request: scriptedRequest(
        [{ status: 302, headers: { location: "https://metadata.example.invalid/latest" } }],
        [],
      ),
    });

    const error = await rejection(fetcher("https://api.example.invalid/v1"));

    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(error).toMatchObject({
      reason: "blocked_address",
      host: "metadata.example.invalid",
      address: "169.254.169.254",
    });
    expect(calls).toBe(2);
  });

  it("rewrites a 303 POST into a bodyless GET", async () => {
    const hops: RecordedHop[] = [];
    const fetcher = createSafeFetch({
      resolve: publicAnswer,
      request: scriptedRequest(
        [
          { status: 303, headers: { location: "https://api.example.invalid/result" } },
          { status: 200, body: "done" },
        ],
        hops,
      ),
    });

    const response = await fetcher("https://api.example.invalid/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });

    expect(response.status).toBe(200);
    expect(hops.map((hop) => hop.method)).toEqual(["POST", "GET"]);
  });

  it("returns the redirect untouched in manual mode and throws in error mode", async () => {
    const script: ScriptedHop[] = [
      { status: 302, headers: { location: "https://api.example.invalid/next" } },
      { status: 302, headers: { location: "https://api.example.invalid/next" } },
    ];
    const fetcher = createSafeFetch({
      resolve: publicAnswer,
      request: scriptedRequest(script, []),
    });

    const manual = await fetcher("https://api.example.invalid/v1", { redirect: "manual" });
    const error = await rejection(fetcher("https://api.example.invalid/v1", { redirect: "error" }));

    expect(manual.status).toBe(302);
    expect(error).toBeInstanceOf(TypeError);
  });

  it("stops at the redirect budget", async () => {
    const loop: ScriptedHop = {
      status: 302,
      headers: { location: "https://api.example.invalid/loop" },
    };
    const fetcher = createSafeFetch({
      resolve: publicAnswer,
      maxRedirects: 2,
      request: scriptedRequest([loop, loop, loop], []),
    });

    const error = await rejection(fetcher("https://api.example.invalid/v1"));

    expect(error).toBeInstanceOf(TypeError);
    expect(String((error as Error).message)).toContain("redirects");
  });
});
