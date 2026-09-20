/**
 * The desktop's loopback origin (slice 11.6).
 *
 * The window cannot load the SPA from one origin and call the API on another:
 * the session cookie is `HttpOnly` and scoped to the server, and the API is
 * built for a single TLS origin. So the desktop serves the packaged build from
 * `127.0.0.1` and forwards the two API mounts — the oRPC endpoint and the auth
 * routes — to the configured deployment from the main process. To the renderer
 * everything is same-origin, and the web build it runs is exactly the one the
 * deployment serves: no screen, transport or cookie rule is re-implemented.
 *
 * The proxy is deliberately small and literal. It forwards a request's method,
 * allowlisted headers, cookie and streamed body; it streams the response back
 * without buffering, so `text/event-stream` reaches the renderer frame by frame
 * and `Last-Event-ID` survives a resume; and it normalizes `Set-Cookie` onto
 * the loopback origin (no `Domain`, no `Secure`, `SameSite=Lax`), so the cookie
 * the server issued is the cookie the renderer carries on the next request.
 *
 * The one route it owns rather than forwards is the setup pair: the first-run
 * page and the address it writes. Everything else is the static host contract
 * from `@porkbot/web`, mounted with the shell's content security policy.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createStaticHandler } from "@porkbot/web";
import {
  applyContentSecurityNonce,
  contentSecurityPolicyFor,
  createContentSecurityNonce,
} from "./hardening.ts";
import { parseServerOrigin } from "./server-origin.ts";
import { setupPage } from "./setup-page.ts";

/** The contract's RPC mount; oRPC addresses procedures below it by path. */
export const rpcPath = "/rpc";
/** The auth library's mount under the API. */
export const authMount = "/api/";

export const setupPagePath = "/__porkbot/setup";
export const serverAddressPath = "/__porkbot/server";

/** True for a request the deployment's API owns rather than the SPA. */
export function isApiPath(pathname: string): boolean {
  return (
    pathname === rpcPath || pathname.startsWith(`${rpcPath}/`) || pathname.startsWith(authMount)
  );
}

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The request headers forwarded upstream; everything else is the proxy's own. */
const forwardedRequestHeaders = ["accept", "accept-language", "content-type", "last-event-id"];

/**
 * Rewrites one `Set-Cookie` so it lands on the loopback origin: the server's
 * `Domain` is dropped, `Path` is the whole origin, and `Secure`/`SameSite=None`
 * become `SameSite=Lax` because the local origin is plain HTTP on loopback.
 * Over loopback those attributes protect nothing, and keeping them would leave
 * the renderer anonymous.
 */
export function rewriteSetCookie(value: string): string {
  const [pair = "", ...attributes] = value.split(";");
  const kept = ["Path=/", "SameSite=Lax"];
  let httpOnly = false;
  let maxAge: string | undefined;
  let expires: string | undefined;

  for (const attribute of attributes) {
    const [rawName = "", ...rest] = attribute.split("=");
    const name = rawName.trim().toLowerCase();
    const attributeValue = rest.join("=").trim();

    if (name === "httponly") {
      httpOnly = true;
    } else if (name === "max-age" && attributeValue !== "") {
      maxAge = `Max-Age=${attributeValue}`;
    } else if (name === "expires" && attributeValue !== "") {
      expires = `Expires=${attributeValue}`;
    }
  }

  const ordered = [
    pair.trim(),
    ...kept,
    ...(expires === undefined ? [] : [expires]),
    ...(maxAge === undefined ? [] : [maxAge]),
    ...(httpOnly ? ["HttpOnly"] : []),
  ];

  return ordered.join("; ");
}

/** The headers a response carries onward; the body is decoded by `fetch`. */
function forwardedResponseHeaders(upstream: Response): Record<string, string[]> {
  const headers: Record<string, string[]> = {};

  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();

    if (hopByHopHeaders.has(lower) || lower === "set-cookie") {
      continue;
    }

    // The body handed to the renderer is decoded and chunked, so the framing
    // headers of the upstream response no longer describe it.
    if (lower === "content-encoding" || lower === "content-length") {
      continue;
    }

    headers[lower] = [...(headers[lower] ?? []), value];
  }

  const cookies = upstream.headers.getSetCookie();

  if (cookies.length > 0) {
    headers["set-cookie"] = cookies.map(rewriteSetCookie);
  }

  return headers;
}

/**
 * Reads the setup post's body with a cap, so a setup request cannot be an
 * unbounded read. `application/x-www-form-urlencoded` is the no-JavaScript
 * shape a plain form posts; JSON is what the app's own page and the tests use.
 */
async function readServerAddress(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;

    if (size > 8 * 1024) {
      throw new Error("too_large");
    }

    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  const contentType = request.headers["content-type"] ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return { origin: new URLSearchParams(text).get("origin") };
  }

  return JSON.parse(text) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * The path and query of a request line, split without inventing an origin for
 * it. The path stays encoded here: it goes upstream as it arrived, and `URL`
 * normalizes any `..` against the configured origin rather than the proxy.
 */
export function requestTarget(rawUrl: string | undefined): {
  readonly pathname: string;
  readonly search: string;
} {
  const raw = rawUrl ?? "/";
  const query = raw.indexOf("?");

  return query === -1
    ? { pathname: raw, search: "" }
    : { pathname: raw.slice(0, query), search: raw.slice(query) };
}

export interface AppServerOptions {
  /** Directory holding the packaged web build, e.g. the app's `dist/client`. */
  readonly clientRoot: string;
  /** The deployment the proxy dials, or `null` before setup. */
  readonly serverOrigin: () => string | null;
  /** Persists a validated address, returning the normalized origin. */
  readonly saveServerOrigin: (origin: string) => Promise<void>;
  /** Injected in tests; defaults to the platform `fetch`. */
  readonly fetch?: typeof fetch;
  /** A one-line note for the app's log; the proxy never logs a header or body. */
  readonly log?: (message: string) => void;
}

export interface AppServer {
  readonly server: Server;
  /** Binds to loopback; port `0` picks a free one and the real port is returned. */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createAppServer(options: AppServerOptions): AppServer {
  const perform = options.fetch ?? globalThis.fetch;
  const staticHandler = createStaticHandler({
    root: options.clientRoot,
    // Every HTML document the proxy hands out gets a fresh nonce: the inline
    // scripts the SPA shell ships run, and anything else the page tries to run
    // is refused by the browser.
    document: (html) => {
      const nonce = createContentSecurityNonce();

      return {
        body: applyContentSecurityNonce(html, nonce),
        headers: { "content-security-policy": contentSecurityPolicyFor(nonce) },
      };
    },
  });

  async function handleSetupPage(response: ServerResponse): Promise<void> {
    const nonce = createContentSecurityNonce();

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": contentSecurityPolicyFor(nonce),
    });
    response.end(applyContentSecurityNonce(setupPage, nonce));
  }

  async function handleServerAddress(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: unknown;

    try {
      body = await readServerAddress(request);
    } catch {
      sendJson(response, 400, { error: "bad_request", message: "The address could not be read." });
      return;
    }

    const raw =
      typeof body === "object" && body !== null ? (body as { origin?: unknown }).origin : undefined;

    if (typeof raw !== "string") {
      sendJson(response, 400, { error: "bad_request", message: "Enter the server's address." });
      return;
    }

    const parsed = parseServerOrigin(raw);

    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.refusal, message: parsed.message });
      return;
    }

    await options.saveServerOrigin(parsed.origin);
    options.log?.("the desktop server address was saved");
    response.writeHead(204);
    response.end();
  }

  async function proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = options.serverOrigin();

    if (origin === null) {
      sendJson(response, 503, {
        error: "server_not_configured",
        message: "No PorkBot server is configured yet.",
      });
      return;
    }

    const { pathname, search } = requestTarget(request.url);
    const target = new URL(`${pathname}${search}`, origin);
    const headers = new Headers();

    for (const name of forwardedRequestHeaders) {
      const value = request.headers[name];

      if (typeof value === "string") {
        headers.set(name, value);
      }
    }

    const cookie = request.headers.cookie;

    if (typeof cookie === "string") {
      headers.set("cookie", cookie);
    }

    // The API's CSRF and trusted-origin checks see the deployment it is
    // mounted on, which is what a same-origin browser request would look like.
    headers.set("origin", origin);

    const abort = new AbortController();
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    response.on("close", () => {
      if (!response.writableEnded) {
        abort.abort();
      }
    });

    let upstream: Response;

    try {
      const init: RequestInit = {
        method: request.method ?? "GET",
        headers,
        redirect: "manual",
        signal: abort.signal,
      };

      if (hasBody) {
        // `duplex: "half"` is the Node fetch contract for a streamed request
        // body; it is what lets an upload cross without buffering the whole
        // file in the main process.
        (init as { body?: RequestInit["body"]; duplex?: "half" }).body = Readable.toWeb(
          request,
        ) as unknown as RequestInit["body"];
        (init as { duplex?: "half" }).duplex = "half";
      }

      upstream = await perform(target, init);
    } catch {
      if (!response.headersSent && !response.writableEnded) {
        sendJson(response, 502, {
          error: "bad_gateway",
          message: "The PorkBot server could not be reached.",
        });
      }

      return;
    }

    response.writeHead(upstream.status, forwardedResponseHeaders(upstream));

    if (upstream.body === null) {
      response.end();
      return;
    }

    // `fetch` types a response body with whichever `ReadableStream` is in
    // scope — the DOM's in a test program that loads it, Node's otherwise —
    // and `Readable.fromWeb` takes Node's. The bytes are the same either way.
    const body = Readable.fromWeb(upstream.body as NodeReadableStream);

    body.on("error", () => response.destroy());
    body.pipe(response);
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const { pathname: rawPathname } = requestTarget(request.url);
      let pathname: string;

      try {
        pathname = decodeURIComponent(rawPathname);
      } catch {
        sendJson(response, 400, { error: "bad_request" });
        return;
      }

      if (pathname === serverAddressPath) {
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" });
          response.end();
          return;
        }

        await handleServerAddress(request, response);
        return;
      }

      if (pathname === setupPagePath) {
        await handleSetupPage(response);
        return;
      }

      if (isApiPath(pathname)) {
        await proxy(request, response);
        return;
      }

      await staticHandler.handle(request, response);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }

      response.end(JSON.stringify({ error: "internal_error" }));
    });
  });

  return {
    server,
    listen: (port = 0) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();

          if (address === null || typeof address === "string") {
            reject(new Error("the desktop host did not bind a TCP address"));
            return;
          }

          resolve(address.port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
