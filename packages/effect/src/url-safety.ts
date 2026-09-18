import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as lookupHost } from "node:dns/promises";
import { once } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { BlockedUrlError } from "./errors.ts";

/**
 * The one module every fetch of a user-supplied URL goes through (PRD decision
 * 23): MCP servers, OpenAPI documents, model endpoints and web fetches all
 * enter here, and a fetch that does not is a bug the call-site suite catches.
 *
 * The security property lives on the connection, not in a string. Because the
 * address that is checked is the address the socket is about to dial, a
 * hostname that resolves to a public address for one look and to a private one
 * for the next cannot slip through: every connection resolves and checks
 * again, so rebinding, a poisoned cache or a `/etc/hosts` edit cannot hand the
 * socket a private address after a pre-flight check would have passed.
 *
 * The rules are one list, `BLOCKED_ADDRESS_RULES`, and `safeFetch` is the one
 * entry point. A caller that needs a different DNS seam (a test) or a different
 * list (never production) builds a fetcher with `createSafeFetch`.
 */

/** A DNS answer: one address and the IP family that parses it. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * The DNS seam. Production uses the OS resolver through `dns.lookup`;
 * a test supplies a controlled sequence so rebinding is a scripted fact rather
 * than a race it hopes to hit.
 */
export type ResolveHost = (
  hostname: string,
  family: 0 | 4 | 6,
) => Promise<readonly ResolvedAddress[]>;

/** One refused range, in one list. `note` says what the range is and why. */
export interface BlockedAddressRule {
  readonly family: 4 | 6;
  readonly cidr: string;
  readonly note: string;
}

/**
 * Every address range a user-supplied URL may not resolve to. The list is the
 * whole policy: there is no second place that decides "private" or "metadata",
 * and the test suite blocks the base address of each entry so a rule that stops
 * matching fails CI.
 *
 * The metadata addresses are not singled out as rules because they already sit
 * inside the ranges that matter: 169.254.169.254 (AWS, GCP, Azure, DigitalOcean)
 * is link-local, 100.100.100.200 (Alibaba) is carrier-grade NAT, and
 * fd00:ec2::254 (AWS IPv6) is unique-local.
 */
export const BLOCKED_ADDRESS_RULES: readonly BlockedAddressRule[] = [
  { family: 4, cidr: "0.0.0.0/8", note: "unspecified and this-network" },
  { family: 4, cidr: "10.0.0.0/8", note: "private" },
  {
    family: 4,
    cidr: "100.64.0.0/10",
    note: "carrier-grade NAT, including the Alibaba metadata address 100.100.100.200",
  },
  { family: 4, cidr: "127.0.0.0/8", note: "loopback" },
  {
    family: 4,
    cidr: "169.254.0.0/16",
    note: "link-local, including the cloud metadata address 169.254.169.254",
  },
  { family: 4, cidr: "172.16.0.0/12", note: "private" },
  { family: 4, cidr: "192.0.0.0/24", note: "IETF protocol assignments" },
  { family: 4, cidr: "192.0.2.0/24", note: "TEST-NET-1 documentation" },
  { family: 4, cidr: "192.88.99.0/24", note: "deprecated 6to4 relay anycast" },
  { family: 4, cidr: "192.168.0.0/16", note: "private" },
  { family: 4, cidr: "198.18.0.0/15", note: "benchmarking" },
  { family: 4, cidr: "198.51.100.0/24", note: "TEST-NET-2 documentation" },
  { family: 4, cidr: "203.0.113.0/24", note: "TEST-NET-3 documentation" },
  { family: 4, cidr: "224.0.0.0/4", note: "multicast" },
  { family: 4, cidr: "240.0.0.0/4", note: "reserved, including the broadcast address" },
  { family: 6, cidr: "::/96", note: "unspecified, loopback and deprecated IPv4-compatible" },
  { family: 6, cidr: "100::/64", note: "discard-only" },
  { family: 6, cidr: "2001::/32", note: "Teredo tunnelling" },
  { family: 6, cidr: "2001:20::/28", note: "ORCHIDv2 identifiers" },
  { family: 6, cidr: "2001:db8::/32", note: "documentation" },
  { family: 6, cidr: "3fff::/20", note: "documentation" },
  {
    family: 6,
    cidr: "fc00::/7",
    note: "unique-local, including the AWS IPv6 metadata address fd00:ec2::254",
  },
  { family: 6, cidr: "fe80::/10", note: "link-local" },
  { family: 6, cidr: "fec0::/10", note: "deprecated site-local" },
  { family: 6, cidr: "ff00::/8", note: "multicast" },
];

const compiledRules = new WeakMap<readonly BlockedAddressRule[], BlockList>();

function blockListFor(rules: readonly BlockedAddressRule[]): BlockList {
  const cached = compiledRules.get(rules);

  if (cached !== undefined) {
    return cached;
  }

  const blockList = new BlockList();

  for (const rule of rules) {
    const slash = rule.cidr.indexOf("/");
    const network = rule.cidr.slice(0, slash);
    const prefix = Number(rule.cidr.slice(slash + 1));

    blockList.addSubnet(network, prefix, rule.family === 4 ? "ipv4" : "ipv6");
  }

  compiledRules.set(rules, blockList);

  return blockList;
}

/** An address with its zone stripped, or `null` when it is not an IP at all. */
function normalizeAddress(address: string): { address: string; family: 4 | 6 } | null {
  const zone = address.indexOf("%");
  const bare = zone === -1 ? address : address.slice(0, zone);
  const family = isIP(bare);

  if (family !== 4 && family !== 6) {
    return null;
  }

  return { address: bare, family };
}

/**
 * The eight 16-bit groups of an IPv6 address, or `null` when the text is not a
 * well-formed IPv6 address. The parser is deliberately small: it exists to find
 * the IPv4 address a transition or mapping form carries, and `isIP` has already
 * vouched for the shape.
 */
function ipv6Groups(address: string): number[] | null {
  const separator = address.indexOf("::");
  const headText = separator === -1 ? address : address.slice(0, separator);
  const tailText = separator === -1 ? "" : address.slice(separator + 2);

  const parseGroups = (text: string): number[] | null => {
    if (text === "") {
      return [];
    }

    const tokens = text.split(":");
    const groups: number[] = [];

    for (const [index, token] of tokens.entries()) {
      if (token.includes(".")) {
        if (index !== tokens.length - 1) {
          return null;
        }

        const octets = token.split(".").map((octet) => Number(octet));

        if (
          octets.length !== 4 ||
          octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        ) {
          return null;
        }

        groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        groups.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/i.test(token)) {
        return null;
      }

      groups.push(Number.parseInt(token, 16));
    }

    return groups;
  };

  const head = parseGroups(headText);
  const tail = parseGroups(tailText);

  if (head === null || tail === null) {
    return null;
  }

  if (separator === -1) {
    return head.length === 8 ? head : null;
  }

  const missing = 8 - head.length - tail.length;

  if (missing < 1) {
    return null;
  }

  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

/**
 * The IPv4 address an IPv6 form carries, when it carries one. The mapped
 * (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96` and the local-use `64:ff9b:1::/48`)
 * and 6to4 (`2002::/16`) forms embed the destination in their low bits, so the
 * check has to look at what they embed or `::ffff:169.254.169.254` would read
 * as a public IPv6 address and dial the metadata service.
 */
function embeddedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);

  if (groups === null) {
    return null;
  }

  const [
    first = 0,
    second = 0,
    third = 0,
    fourth = 0,
    fifth = 0,
    sixth = 0,
    seventh = 0,
    eighth = 0,
  ] = groups;
  const isMapped = first + second + third + fourth + fifth === 0 && sixth === 0xffff;
  const isNat64 = first === 0x64 && second === 0xff9b && third + fourth + fifth + sixth === 0;
  const isNat64Local = first === 0x64 && second === 0xff9b && third === 0x0001;
  const isSixToFour = first === 0x2002;

  if (!isMapped && !isNat64 && !isNat64Local && !isSixToFour) {
    return null;
  }

  // The mapped and NAT64 forms put the IPv4 address in the last two groups;
  // 6to4 puts it in the two groups that follow the 2002: prefix.
  const high = isSixToFour ? second : seventh;
  const low = isSixToFour ? third : eighth;

  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Whether one textual address is inside the blocked set. Unparseable input is
 * blocked: the function answers "may this be dialed?" and an address it cannot
 * read is not an address it can clear. A zone (`fe80::1%eth0`) is stripped
 * before the check, because the zone names an interface, not a destination.
 */
export function isBlockedAddress(
  address: string,
  rules: readonly BlockedAddressRule[] = BLOCKED_ADDRESS_RULES,
): boolean {
  const normalized = normalizeAddress(address);

  if (normalized === null) {
    return true;
  }

  const blockList = blockListFor(rules);
  const embedded = normalized.family === 6 ? embeddedIpv4(normalized.address) : null;

  if (embedded !== null && blockList.check(embedded, "ipv4")) {
    return true;
  }

  return blockList.check(normalized.address, normalized.family === 4 ? "ipv4" : "ipv6");
}

/**
 * The cheap pre-flight: the scheme, the credentials and a literal address.
 * It is not the gate for a hostname — every connection resolves and checks
 * again — but a plain-http or credential-bearing URL is refused before a
 * request is built, with the typed error a caller can act on.
 *
 * A URL whose host is already an IP literal is checked here because it never
 * reaches the resolver: `node:net` skips the `lookup` function for numeric
 * hosts and dials the address directly. There is nothing to rebind in that
 * case — the address checked is exactly the address dialed — but it still has
 * to be checked, or `https://169.254.169.254/` would sail past the guard.
 */
export function assertAllowedUrl(input: string | URL): URL {
  let url: URL;

  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new BlockedUrlError("invalid_url");
  }

  if (url.protocol !== "https:") {
    throw new BlockedUrlError("insecure_scheme", url.hostname);
  }

  if (url.username !== "" || url.password !== "") {
    throw new BlockedUrlError("embedded_credentials", url.hostname);
  }

  const hostname = url.hostname;
  const literal =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (isIP(literal) !== 0 && isBlockedAddress(literal)) {
    throw new BlockedUrlError("blocked_address", hostname, literal);
  }

  return url;
}

/** The `lookup` seam `node:net` and `node:https` call at connection time. */
export type GuardedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

const resolveWithSystemDns: ResolveHost = async (hostname, family) => {
  const answers = await lookupHost(hostname, { all: true, family, verbatim: true });

  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

/**
 * The resolver the socket actually uses. It is a `lookup` function, so Node
 * calls it immediately before dialing — no request path can skip it, and every
 * connection asks again. The answer is refused when *any* resolved address is
 * blocked, not only the one that would be dialed first: a host that returns one
 * public and one private address is a rebinding attempt, not a multi-homed
 * host.
 */
export function createGuardedLookup(
  options: { readonly resolve?: ResolveHost; readonly rules?: readonly BlockedAddressRule[] } = {},
): GuardedLookup {
  const resolve = options.resolve ?? resolveWithSystemDns;
  const rules = options.rules ?? BLOCKED_ADDRESS_RULES;

  return (hostname, lookupOptions, callback) => {
    const family =
      lookupOptions.family === 4 || lookupOptions.family === 6 ? lookupOptions.family : 0;

    resolve(hostname, family).then(
      (answers) => {
        const resolved = answers.map((answer) => ({
          address: answer.address,
          family: answer.family === 6 ? 6 : 4,
        }));

        const blocked = resolved.find((answer) => isBlockedAddress(answer.address, rules));

        if (blocked !== undefined) {
          callback(new BlockedUrlError("blocked_address", hostname, blocked.address), "", 4);
          return;
        }

        const first = resolved[0];

        if (first === undefined) {
          callback(new BlockedUrlError("blocked_address", hostname), "", 4);
          return;
        }

        if (lookupOptions.all === true) {
          callback(
            null,
            resolved.map((answer) => ({ ...answer })),
          );
          return;
        }

        callback(null, first.address, first.family);
      },
      (cause: unknown) => {
        callback(cause instanceof Error ? cause : new Error(String(cause)), "", 4);
      },
    );
  };
}

/** The header forms a call site may pass; the same union the platform `fetch` accepts. */
export type SafeFetchHeaders = NonNullable<RequestInit["headers"]>;

/**
 * The body forms a call site may pass. A string or a byte array is replayable
 * and can cross a redirect; a stream or an async iterable is written to the
 * socket as it is produced — an upload streams instead of buffering — and is
 * therefore refused across a redirect, because a consumed source cannot be
 * sent twice and silently sending half of it would be worse.
 */
export type SafeFetchBody =
  string | Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/** The subset of `fetch` this module implements: the init a server-side fetch needs. */
export interface SafeFetchInit {
  readonly method?: string;
  readonly headers?: SafeFetchHeaders;
  readonly body?: SafeFetchBody;
  readonly signal?: AbortSignal;
  readonly redirect?: "follow" | "error" | "manual";
  /**
   * The platform fetch requires `duplex: "half"` when the body is a stream;
   * this module streams by construction and accepts the flag so the same init
   * can be passed to either implementation.
   */
  readonly duplex?: "half";
}

/** The fetcher's shape. It is deliberately `fetch`-like, so a call site reads as one. */
export type SafeFetch = (url: string | URL, init?: SafeFetchInit) => Promise<Response>;

/**
 * The knobs a test needs: a controlled resolver and, for the redirect wire
 * test, a scripted `https.request`. Production calls `safeFetch` and passes
 * neither; the default rules are the list above.
 */
export interface UrlSafetyOptions {
  readonly resolve?: ResolveHost;
  readonly rules?: readonly BlockedAddressRule[];
  readonly request?: typeof httpsRequest;
  readonly maxRedirects?: number;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 20;

function nodeHeaders(headers: SafeFetchHeaders | undefined): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const normalized: Record<string, string> = {};

  for (const [name, value] of new Headers(headers)) {
    normalized[name] = value;
  }

  return normalized;
}

function stripSensitiveHeaders(
  headers: SafeFetchHeaders | undefined,
): SafeFetchHeaders | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const filtered = new Headers(headers);

  for (const name of ["authorization", "cookie", "proxy-authorization"]) {
    filtered.delete(name);
  }

  return filtered;
}

/**
 * A redirect that turns a request bodyless must not carry the body's framing
 * headers: a `content-length` with no bytes makes the next hop wait for a body
 * that never arrives.
 */
function stripBodyHeaders(headers: SafeFetchHeaders | undefined): SafeFetchHeaders | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const filtered = new Headers(headers);

  for (const name of ["content-length", "content-type", "transfer-encoding"]) {
    filtered.delete(name);
  }

  return filtered;
}

function toResponse(incoming: IncomingMessage, url: URL, method: string, hops: number): Response {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    headers.set(name, value);
  }

  const status = incoming.statusCode ?? 500;
  const hasBody = method !== "HEAD" && status !== 204 && status !== 304 && status >= 200;
  const body = hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null;
  const response = new Response(body, {
    status,
    statusText: incoming.statusMessage ?? "",
    headers,
  });

  // `Response.url` and `.redirected` are read-only in the constructor, but a
  // fetch is only useful if the caller can learn where it landed: a redirected
  // OpenAPI document resolves its relative references against the final URL.
  Object.defineProperty(response, "url", { value: url.href, configurable: true });
  Object.defineProperty(response, "redirected", { value: hops > 0, configurable: true });

  return response;
}

function requestOnce(
  request: typeof httpsRequest,
  target: URL,
  init: SafeFetchInit,
  lookup: GuardedLookup,
  hops: number,
): Promise<Response> {
  const method = init.method ?? "GET";
  const headers = nodeHeaders(init.headers);

  return new Promise((resolve, reject) => {
    const message = request(
      target,
      {
        method,
        agent: false,
        lookup,
        ...(headers === undefined ? {} : { headers }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      },
      (incoming) => {
        resolve(toResponse(incoming, target, method, hops));
      },
    );

    message.on("error", reject);

    if (init.body === undefined) {
      message.end();
      return;
    }

    if (isReplayableBody(init.body)) {
      message.end(init.body);
      return;
    }

    // A streamed body is written with backpressure, and a source that throws
    // destroys the request instead of leaving a half-sent upload on the wire.
    void writeStreamingBody(message, init.body).catch((cause: unknown) => {
      message.destroy(cause instanceof Error ? cause : new Error(String(cause)));
    });
  });
}

/** Strings and byte arrays can be sent again after a redirect; a stream cannot. */
function isReplayableBody(body: SafeFetchBody): body is string | Uint8Array {
  return typeof body === "string" || body instanceof Uint8Array;
}

async function writeStreamingBody(
  message: ClientRequest,
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();

  try {
    while (!message.destroyed) {
      const read = await iterator.next();

      if (read.done === true) {
        message.end();
        return;
      }

      if (!message.write(read.value)) {
        await once(message, "drain");
      }
    }
  } finally {
    if (message.destroyed) {
      // The request is already gone, so the source's cleanup must still run;
      // its failure is moot because the request rejects with the real cause.
      const closed = iterator.return?.();

      if (closed !== undefined) {
        await closed.catch(() => undefined);
      }
    }
  }
}

function dropsBodyOnRedirect(status: number, method: string): boolean {
  return status === 303 || ((status === 301 || status === 302) && method.toUpperCase() === "POST");
}

function redirectInit(init: SafeFetchInit, status: number, from: URL, to: URL): SafeFetchInit {
  const method = init.method ?? "GET";
  const dropBody = dropsBodyOnRedirect(status, method);
  const sameOrigin = from.origin === to.origin ? init.headers : stripSensitiveHeaders(init.headers);
  const headers = dropBody ? stripBodyHeaders(sameOrigin) : sameOrigin;

  return {
    redirect: init.redirect ?? "follow",
    ...(init.signal === undefined ? {} : { signal: init.signal }),
    ...(headers === undefined ? {} : { headers }),
    method: dropBody ? "GET" : method,
    ...(dropBody || init.body === undefined ? {} : { body: init.body }),
  };
}

async function fetchWithRedirects(
  request: typeof httpsRequest,
  lookup: GuardedLookup,
  limit: number,
  hops: number,
  target: URL,
  init: SafeFetchInit,
): Promise<Response> {
  const response = await requestOnce(request, target, init, lookup, hops);
  const location = response.headers.get("location");

  if (!redirectStatuses.has(response.status) || location === null) {
    return response;
  }

  const mode = init.redirect ?? "follow";

  if (mode === "manual") {
    return response;
  }

  if (
    mode === "follow" &&
    init.body !== undefined &&
    !isReplayableBody(init.body) &&
    !dropsBodyOnRedirect(response.status, init.method ?? "GET")
  ) {
    // The body was already written to the wire; sending a consumed source
    // again would upload nothing or half of it, so refuse instead.
    await response.body?.cancel();
    throw new TypeError("cannot follow a redirect with a streaming request body");
  }

  await response.body?.cancel();

  if (mode === "error") {
    throw new TypeError(`redirect received for ${target.origin} while redirect mode is "error"`);
  }

  if (hops >= limit) {
    throw new TypeError(`more than ${limit} redirects while fetching ${target.origin}`);
  }

  // The next hop is a new URL a caller did not name, so it passes the same
  // pre-flight: a redirect cannot downgrade to http or smuggle credentials
  // into the authority.
  const next = assertAllowedUrl(new URL(location, target));

  return fetchWithRedirects(
    request,
    lookup,
    limit,
    hops + 1,
    next,
    redirectInit(init, response.status, target, next),
  );
}

/**
 * Builds a fetcher with the given policy. Tests use it to inject a controlled
 * resolver and a scripted request; production uses `safeFetch`, which is this
 * with no arguments, so the default rules and the real DNS are what ship.
 */
export function createSafeFetch(options: UrlSafetyOptions = {}): SafeFetch {
  const lookup = createGuardedLookup(options);
  const request = options.request ?? httpsRequest;
  const limit = options.maxRedirects ?? maxRedirects;

  return async (url, init = {}) =>
    fetchWithRedirects(request, lookup, limit, 0, assertAllowedUrl(url), init);
}

/** The fetcher every call site uses. */
export const safeFetch: SafeFetch = createSafeFetch();
