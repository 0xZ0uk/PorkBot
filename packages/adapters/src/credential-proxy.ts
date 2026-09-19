import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertAllowedUrl, createProxyCapabilityCodec, createSafeFetch } from "@porkbot/effect";
import type { ProxyCapabilityCodec, ProxyCapabilityRejection, SafeFetch } from "@porkbot/effect";
import type { ComputerProxyGrant, ComputerRef, ProxyUpstreamGrant } from "@porkbot/adapter-kit";

/**
 * The credential proxy (slice 7.8, PRD decision 29; audit P1 item 7).
 *
 * The one door credentialed egress takes out of a sandbox. A run's upstream
 * credentials live here — in the proxy's grant directory, which the Docker
 * socket holder writes through the daemon's archive API — and what the
 * sandbox holds in their place is a signed capability: bound to one run and
 * one computer, expired within minutes, and useless against any grant that is
 * not already written for its run. No credential crosses into the sandbox's
 * environment, its files or its process list, because none ever leaves this
 * process.
 *
 * The trust posture is deliberately narrow:
 *
 *   - the capability is verified before anything is read, and its binding is
 *     checked against the computer this proxy was configured to serve — a
 *     token for another computer, another run, another bot or another
 *     deployment's key is a refusal, and a refusal never names what it lacked;
 *   - the grant is read from the grant directory on every request, so
 *     revocation is a deleted file and expiry is a timestamp inside it — a
 *     crashed writer cannot leave a run's credentials reachable past the
 *     deadline the grant itself declared;
 *   - the allowlist is per grant: the sandbox names an upstream (`model`,
 *     `github`) and the grant alone decides which origin that name dials and
 *     which headers — the credential — get injected. A name the grant does
 *     not carry is refused before any request is made;
 *   - the upstream leg is `safeFetch`: HTTPS only, no embedded credentials,
 *     the dialed address checked on the socket, redirects refused — the same
 *     list every other egress path enforces, so the proxy is not a second,
 *     drifting policy;
 *   - everything is bounded: the request body, the response body, the
 *     upstream wait and the grant file itself each have a cap, so a sandbox
 *     cannot make the proxy buffer or wait past a budget;
 *   - nothing sensitive is logged or echoed: the token, the injected headers
 *     and the request body are never written to a response or a log line —
 *     refusals carry a small typed reason and nothing else.
 *
 * The grant file is the whole control plane: `runId`, a hard expiry in Unix
 * seconds, and the upstream set. The supervisor writes it through the daemon
 * onto the sidecar's own layer (or drops it in the emulator's grant
 * directory); settling the run revokes it. There is deliberately no list
 * route, no grant read route and no admin surface: a caller with a token can
 * use a grant and nothing more, which is what keeps one run unable to
 * enumerate another's.
 */

/** The methods a sandbox may ask the proxy to send; nothing else crosses. */
const FORWARDED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * The headers a sandbox's request may carry upstream. Everything else —
 * `authorization`, `cookie`, `host`, the proxy token itself — is dropped, so
 * the only credential headers on the wire are the ones the grant injected.
 */
const FORWARDED_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"]);

/**
 * The response headers passed back. `content-type` is what the caller needs;
 * anything else risks leaking an upstream's internals (and `set-cookie` would
 * hand the sandbox a second credential).
 */
const RETURNED_HEADERS = new Set(["content-type", "content-language", "cache-control"]);

/**
 * Headers a grant may never inject: framing, routing and the proxy's own
 * authentication belong to the proxy, not to a run's plan. A grant that names
 * one is refused when it is parsed — fail closed — and the injection loop
 * skips them besides, so no path can hand a run control of the connection it
 * did not have or echo a capability upstream.
 */
export const FORBIDDEN_GRANT_HEADERS: readonly string[] = [
  "host",
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "expect",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "cookie2",
  "x-porkbot-proxy-token",
];

const forbiddenGrantHeaders = new Set(FORBIDDEN_GRANT_HEADERS);

function usableGrantHeader(name: string, value: string): boolean {
  return (
    name !== "" && !forbiddenGrantHeaders.has(name) && !/[\r\n]/.test(name) && !/[\r\n]/.test(value)
  );
}

/** The capability token travels in its own header, never the URL. */
export const proxyTokenHeader = "x-porkbot-proxy-token";

/** The largest request body the proxy will read, in bytes (4 MiB). */
export const PROXY_MAX_REQUEST_BYTES = 4_194_304;
/** The largest upstream response the proxy will return, in bytes (16 MiB). */
export const PROXY_MAX_RESPONSE_BYTES = 16_777_216;
/** The largest grant file the proxy will read, in bytes; a grant is kilobytes. */
export const PROXY_MAX_GRANT_BYTES = 65_536;
/** The longest upstream name; the sandbox types it, so it stays small. */
export const PROXY_MAX_UPSTREAM_NAME_LENGTH = 64;
/** How long one upstream call may take, in milliseconds. */
export const PROXY_UPSTREAM_TIMEOUT_MS = 60_000;

/** The file a run's grant lives in — one name, no directories, no traversal. */
export function proxyGrantFileName(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new RangeError(`a run id cannot name a grant file: ${JSON.stringify(runId)}`);
  }

  return `${runId}.json`;
}

/** The grant's wire shape, shared by the writer (the supervisor) and the reader (the proxy). */
export function serializeProxyGrant(grant: ComputerProxyGrant): Uint8Array {
  return Buffer.from(JSON.stringify(grant), "utf8");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function parseUpstream(value: unknown): ProxyUpstreamGrant | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const name = record["name"];
  const origin = record["origin"];
  const headers = record["headers"];

  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > PROXY_MAX_UPSTREAM_NAME_LENGTH ||
    typeof origin !== "string" ||
    origin.length === 0
  ) {
    return undefined;
  }

  if (headers === undefined) {
    return { name, origin };
  }

  if (!isStringRecord(headers)) {
    return undefined;
  }

  const usable = Object.entries(headers);

  return usable.every(([header, value]) => usableGrantHeader(header.toLowerCase(), value))
    ? { name, origin, headers }
    : undefined;
}

/**
 * Parses one grant file. A malformed grant is not a request error and not a
 * crash — it is `undefined`, and every request that names its run is refused,
 * so a corrupt control file fails closed.
 */
export function parseProxyGrantFile(
  runId: string,
  bytes: Uint8Array,
): ComputerProxyGrant | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const expiresAtSeconds = record["expiresAtSeconds"];
  const upstreams = record["upstreams"];

  if (
    record["runId"] !== runId ||
    typeof expiresAtSeconds !== "number" ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= 0 ||
    !Array.isArray(upstreams)
  ) {
    return undefined;
  }

  const parsedUpstreams = upstreams.map(parseUpstream);

  return parsedUpstreams.includes(undefined)
    ? undefined
    : {
        runId,
        expiresAtSeconds,
        upstreams: parsedUpstreams as readonly ProxyUpstreamGrant[],
      };
}

/** A refusal this module itself decided; the status and reason go out as written. */
class ProxyRefusal extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(reason);
    this.name = "ProxyRefusal";
    this.status = status;
    this.reason = reason;
  }
}

export interface CredentialProxyServerOptions {
  /** The HMAC key the run's capability tokens are signed with. */
  readonly tokenSecret: string | Uint8Array;
  /** The computer this proxy serves; a token bound to another is refused. */
  readonly computer: ComputerRef;
  /** The directory grant files are read from; the Docker socket holder writes it. */
  readonly grantDir: string;
  /** The bind address; loopback for the emulator, the pod interface for a sidecar. */
  readonly host?: string | undefined;
  /** The bind port; `0` asks the kernel for one. */
  readonly port?: number | undefined;
  /** The upstream leg; `safeFetch` by default, injected in tests. */
  readonly fetch?: SafeFetch | undefined;
  /** The clock, in whole seconds; injected in tests. */
  readonly nowSeconds?: (() => number) | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly upstreamTimeoutMs?: number | undefined;
}

export interface CredentialProxyServer {
  /** The base URL callers inside the sandbox boundary dial, for example `http://127.0.0.1:51234`. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const rejectionStatus: Record<ProxyCapabilityRejection, number> = {
  malformed: 401,
  forged: 401,
  expired: 401,
  binding: 403,
};

function writeRefusal(response: ServerResponse, status: number, reason: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: reason }));
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  const declaredLength = typeof declared === "string" ? Number(declared) : Number.NaN;

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    // The refusal goes out without the body being read; the server discards
    // the rest rather than buffering past the bound.
    throw new ProxyRefusal(413, "request_too_large");
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;

    if (size > maxBytes) {
      throw new ProxyRefusal(413, "request_too_large");
    }

    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

async function readUpstreamBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  const declaredLength = declared === null ? Number.NaN : Number(declared);

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProxyRefusal(502, "upstream_response_too_large");
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (reader === undefined) {
    return Buffer.alloc(0);
  }

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProxyRefusal(502, "upstream_response_too_large");
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

export function createCredentialProxyServer(
  options: CredentialProxyServerOptions,
): Promise<CredentialProxyServer> {
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const codec: ProxyCapabilityCodec = createProxyCapabilityCodec(options.tokenSecret, {
    nowSeconds,
  });
  const upstreamFetch = options.fetch ?? createSafeFetch();
  const maxRequestBytes = options.maxRequestBytes ?? PROXY_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? PROXY_MAX_RESPONSE_BYTES;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? PROXY_UPSTREAM_TIMEOUT_MS;

  if (options.computer.computerId.trim() === "" || options.computer.botId.trim() === "") {
    throw new RangeError("a credential proxy needs the computer it serves");
  }

  async function loadGrant(runId: string): Promise<ComputerProxyGrant> {
    let bytes: Buffer;

    try {
      bytes = await readFile(path.join(options.grantDir, proxyGrantFileName(runId)));
    } catch {
      // Missing, unreadable or a race with revoke: one refusal, no detail.
      throw new ProxyRefusal(403, "no_grant");
    }

    if (bytes.byteLength > PROXY_MAX_GRANT_BYTES) {
      throw new ProxyRefusal(403, "no_grant");
    }

    const grant = parseProxyGrantFile(runId, bytes);

    if (grant === undefined) {
      throw new ProxyRefusal(403, "no_grant");
    }

    // The grant's own deadline is a bound a crashed writer cannot escape:
    // the file may still be there, but the run it was written for is over.
    if (nowSeconds() >= grant.expiresAtSeconds) {
      throw new ProxyRefusal(403, "no_grant");
    }

    return grant;
  }

  async function proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://proxy");

    if (request.method === "GET" && url.pathname === "/healthz") {
      // Liveness only: the sidecar has no readiness state beyond "the server
      // is up", and this answer carries no grant, no run and no configuration.
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const segments = url.pathname.split("/").filter((part) => part !== "");

    if (segments[0] !== "u" || segments.length < 2) {
      throw new ProxyRefusal(404, "no_route");
    }

    if (request.method === undefined || !FORWARDED_METHODS.has(request.method)) {
      throw new ProxyRefusal(405, "method_not_allowed");
    }

    const name = decodeURIComponent(segments[1] ?? "");
    const upstreamPath = `/${segments.slice(2).map(decodeURIComponent).join("/")}${url.search}`;

    // The capability is checked before the grant is read, so a forged or
    // foreign token cannot learn whether a grant exists.
    const token = request.headers[proxyTokenHeader];
    const verdict =
      typeof token === "string"
        ? codec.verify(token, {
            computerId: options.computer.computerId,
            botId: options.computer.botId,
          })
        : ({ valid: false, reason: "malformed" } as const);

    if (!verdict.valid) {
      throw new ProxyRefusal(rejectionStatus[verdict.reason], `capability_${verdict.reason}`);
    }

    const grant = await loadGrant(verdict.binding.runId);
    const upstream = grant.upstreams.find((entry) => entry.name === name);

    if (upstream === undefined) {
      // A name the grant does not carry is refused before a request is made;
      // the allowlist is per run, not per deployment.
      throw new ProxyRefusal(403, "upstream_not_allowed");
    }

    // The sandbox names a path, never an origin: the origin comes from the
    // grant and is concatenated here. A path that could re-enter the URL's
    // authority (a leading `//`, or a backslash URL parsing treats as one) is
    // refused outright, and the assembled URL's origin is checked besides, so
    // a traversal or an encoding trick cannot make the proxy dial anywhere but
    // the granted host.
    if (upstreamPath.startsWith("//") || upstreamPath.startsWith("/\\")) {
      throw new ProxyRefusal(400, "bad_upstream_path");
    }

    let target: URL;

    try {
      target = new URL(`${upstream.origin}${upstreamPath}`);
    } catch {
      throw new ProxyRefusal(400, "bad_upstream_path");
    }

    if (target.origin !== new URL(upstream.origin).origin) {
      throw new ProxyRefusal(400, "bad_upstream_path");
    }

    try {
      // A grant that declares an insecure, credentialed or literally-blocked
      // origin is refused here; the resolver-level rules still apply inside
      // `safeFetch`, so this check is the cheap half of one policy.
      assertAllowedUrl(target);
    } catch {
      throw new ProxyRefusal(403, "upstream_not_allowed");
    }

    const headers: Record<string, string> = {};

    for (const [header, value] of Object.entries(request.headers)) {
      const lowered = header.toLowerCase();

      if (FORWARDED_HEADERS.has(lowered) && typeof value === "string") {
        headers[lowered] = value;
      }
    }

    // The credential crosses here and nowhere else: after the allowlist so a
    // request's own headers can never shadow it, never into a log line, and
    // never over the framing headers the proxy owns.
    for (const [header, value] of Object.entries(upstream.headers ?? {})) {
      const lowered = header.toLowerCase();

      if (usableGrantHeader(lowered, value)) {
        headers[lowered] = value;
      }
    }

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readRequestBody(request, maxRequestBytes);

    let upstreamResponse: Response;

    try {
      upstreamResponse = await upstreamFetch(target, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
    } catch (error) {
      // A refused URL, a blocked address, a timed-out socket: one refusal.
      // The typed BlockedUrlError detail stays out of the response so a
      // sandbox cannot probe which rule fired.
      throw new ProxyRefusal(
        502,
        error instanceof Error && error.name === "TimeoutError"
          ? "upstream_timed_out"
          : "upstream_refused",
      );
    }

    const upstreamBody = await readUpstreamBody(upstreamResponse, maxResponseBytes);
    const responseHeaders: Record<string, string> = {};

    upstreamResponse.headers.forEach((value, header) => {
      if (RETURNED_HEADERS.has(header.toLowerCase())) {
        responseHeaders[header] = value;
      }
    });

    response.writeHead(upstreamResponse.status, {
      ...responseHeaders,
      "content-length": upstreamBody.byteLength,
    });
    response.end(upstreamBody);
  }

  const server: Server = createServer((request, response) => {
    void proxy(request, response).catch((error: unknown) => {
      if (error instanceof ProxyRefusal) {
        writeRefusal(response, error.status, error.reason);
        return;
      }

      writeRefusal(response, 500, "proxy_failed");
    });
  });

  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 0;

  return new Promise<CredentialProxyServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;

      resolve({
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${bound}`,
        port: bound,
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}
