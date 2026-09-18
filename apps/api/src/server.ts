import { createServer } from "node:http";
import type { Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createApiApp } from "./app.ts";
import type { ApiAppOptions } from "./app.ts";

export { serviceName } from "./app.ts";

/**
 * The API as a Node HTTP server: Hono owns the surface and the node adapter
 * turns `app.fetch` into a request listener, so the same app runs under the
 * server here and under a test's `app.request` without a second code path.
 */
export function createApiServer(options: ApiAppOptions): Server {
  const app = createApiApp(options);

  return createServer(getRequestListener(app.fetch));
}
