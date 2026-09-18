import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { moduleInfo as contracts } from "@porkbot/contracts";
import { moduleInfo as core } from "@porkbot/core";
import { createLogger, moduleInfo as logging, redactPath } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";

export const serviceName = "@porkbot/api";

export interface ApiServerOptions {
  /** Defaults to a JSON logger for this service. */
  readonly logger?: Logger;
  /** Request id factory used when the client did not supply one. */
  readonly generateRequestId?: () => string;
}

function requestIdFor(request: IncomingMessage, generate: () => string): string {
  const header = request.headers["x-request-id"];
  const value = Array.isArray(header) ? header.find((entry) => entry.trim() !== "") : header;
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return generate();
}

function route(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ok",
        service: serviceName,
        modules: [core.name, contracts.name, logging.name],
      }),
    );
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

/**
 * Builds the request listener. Every request gets a correlation id, a request
 * log line when the response finishes (redacted, with the status deciding the
 * level), and an error log line should the handler throw. Logging is the
 * listener's job rather than a middleware so it cannot be forgotten per route.
 */
export function createRequestListener(
  options: ApiServerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  const logger = options.logger ?? createLogger({ service: serviceName });
  const generateRequestId = options.generateRequestId ?? randomUUID;

  return (request, response) => {
    const startedAt = performance.now();
    let requestLogger = logger;

    // Registered before anything can throw, so every finished response gets a
    // request line even when the correlation id itself could not be read.
    response.on("finish", () => {
      requestLogger.request({
        method: request.method ?? "GET",
        path: request.url ?? "/",
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    try {
      const requestId = requestIdFor(request, generateRequestId);
      requestLogger = logger.child({ requestId });
      response.setHeader("x-request-id", requestId);

      route(request, response);
    } catch (error) {
      requestLogger.error("request failed", {
        error,
        method: request.method ?? "GET",
        path: redactPath(request.url ?? "/"),
      });

      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: "internal_error" }));
    }
  };
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  return createServer(createRequestListener(options));
}
