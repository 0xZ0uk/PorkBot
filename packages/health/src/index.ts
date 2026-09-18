import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** The path every process answers its container healthcheck on. */
export const healthPath = "/healthz";

export interface HealthEndpointOptions {
  /** Service identity echoed in the response, e.g. `@porkbot/worker`. */
  readonly service: string;
}

/**
 * Answers `GET /healthz` with `{ status: "ok", service }` and returns true.
 * Every other request is left untouched and returns false, so a process with
 * routes of its own composes this without giving up its server.
 */
export function createHealthListener(
  options: HealthEndpointOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    if (request.method !== "GET" || request.url !== healthPath) {
      return false;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: options.service }));
    return true;
  };
}

/**
 * A server whose only route is the health probe. Always-on processes with no
 * HTTP surface of their own (worker, supervisor) run this so the container
 * healthcheck asks the process a question rather than guessing from outside.
 */
export function createHealthServer(options: HealthEndpointOptions): Server {
  const listener = createHealthListener(options);

  return createServer((request, response) => {
    if (listener(request, response)) {
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}
