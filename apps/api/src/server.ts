import { createServer } from "node:http";
import type { Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApiApp } from "./app.ts";
import type { ApiAppOptions } from "./app.ts";

export { serviceName } from "./app.ts";

/**
 * The API as a Node HTTP server: Hono owns the surface and the node adapter
 * turns `app.fetch` into a request listener, so the same app runs under the
 * server here and under a test's `app.request` without a second code path.
 *
 * The server supplies the client address the anonymous budgets are keyed by
 * from the connection itself, never from a header a caller can set; a process
 * behind a proxy should pass its own `clientKey` rather than trust
 * `X-Forwarded-For` implicitly.
 */
export function createApiServer(options: ApiAppOptions): Server {
  const app = createApiApp({
    ...options,
    clientKey: options.clientKey ?? ((context) => getConnInfo(context).remote.address ?? "unknown"),
  });

  return createServer(getRequestListener(app.fetch));
}
