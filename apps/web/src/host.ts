import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { createHealthListener } from "@porkbot/health";

/**
 * The static host for the built SPA. It is not a client runtime: it serves
 * files and answers the container healthcheck, and every application behaviour
 * lives in the bundle it hands out.
 *
 * The one route-like rule is the SPA rewrite: a request that names an existing
 * file gets it, a request for a path with no file extension gets the shell and
 * lets the router resolve it, and a missing asset stays a 404. That is the
 * same contract the single TLS origin implements in a deployment, so what this
 * server exercises is what production serves.
 */

export const serviceName = "@porkbot/web";

/** The shell entry TanStack Start writes for SPA mode. */
export const shellFileName = "_shell.html";

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export interface StaticServerOptions {
  /** Directory holding the built client, e.g. `dist/client`. */
  readonly root: string;
}

function contentTypeFor(file: string): string {
  return contentTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** True only for a path inside `root`; `..` and NUL never escape it. */
function resolveWithin(root: string, pathname: string): string | undefined {
  if (pathname.includes("\0")) {
    return undefined;
  }

  const resolved = path.resolve(root, `.${pathname}`);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return undefined;
  }

  return resolved;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function streamFile(response: ServerResponse, file: string, head = false): void {
  response.writeHead(200, {
    "content-type": contentTypeFor(file),
    "cache-control": "no-cache",
  });

  if (head) {
    response.end();
    return;
  }

  const stream = createReadStream(file);

  // A file that disappears between the stat and the read is not a reason to
  // take the process down with an unhandled stream error. The response is
  // already committed to 200, so the honest end is a dropped response.
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

export function createStaticServer(options: StaticServerOptions): Server {
  const root = path.resolve(options.root);
  const shell = path.join(root, shellFileName);
  const health = createHealthListener({ service: serviceName });

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (health(request, response)) {
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" });
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", "http://localhost");
      let pathname: string;

      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "bad_request" }));
        return;
      }

      const requested = resolveWithin(
        root,
        pathname.endsWith("/") ? `${pathname}index.html` : pathname,
      );

      // A path that escapes the root is not a client route, whatever it looks
      // like: it is refused rather than answered with the shell.
      if (requested === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      const head = request.method === "HEAD";

      if (await isFile(requested)) {
        streamFile(response, requested, head);
        return;
      }

      // A missing extension-less path is a client route; a missing asset is a
      // missing file. Serving the shell for the latter would turn a broken
      // bundle reference into a blank page with a 200.
      if (path.extname(pathname) !== "" || !(await isFile(shell))) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      streamFile(response, shell, head);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }

      response.end(JSON.stringify({ error: "internal_error" }));
    });
  });
}
