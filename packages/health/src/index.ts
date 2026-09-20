import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** The legacy process-health path retained for existing deployments. */
export const healthPath = "/healthz";

/** The path that answers whether the process is still serving requests. */
export const livenessPath = "/livez";

/** The path that answers whether the process may receive work. */
export const readinessPath = "/readyz";

export type ReadinessCheck = () => boolean | Promise<boolean>;

export type HealthStatus = "ok" | "ready" | "not_ready";

export interface HealthPayload {
  readonly status: HealthStatus;
  readonly service: string;
}

export interface HealthEndpointOptions {
  /** Service identity echoed in the response, e.g. `@porkbot/worker`. */
  readonly service: string;
  /** Dependency check for readiness; a rejection is reported as not ready. */
  readonly readiness?: ReadinessCheck;
}

export function healthPayload(service: string, status: HealthStatus): HealthPayload {
  return { status, service };
}

function writeJson(response: ServerResponse, status: number, body: HealthPayload): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Runs a readiness check without allowing dependency details onto the wire. */
export async function checkReadiness(check: ReadinessCheck | undefined): Promise<boolean> {
  if (check === undefined) {
    return true;
  }

  try {
    return await check();
  } catch {
    return false;
  }
}

/**
 * Answers the legacy `/healthz` and the liveness `/livez` probes with
 * `{ status: "ok", service }` and returns true. Every other request is left
 * untouched and returns false, so a process with routes of its own composes
 * this without giving up its server.
 */
export function createHealthListener(
  options: HealthEndpointOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    if (request.method !== "GET" || (request.url !== healthPath && request.url !== livenessPath)) {
      return false;
    }

    writeJson(response, 200, healthPayload(options.service, "ok"));
    return true;
  };
}

/** Answers the asynchronous readiness probe and returns whether it claimed it. */
export function createReadinessListener(
  options: HealthEndpointOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    if (request.method !== "GET" || request.url !== readinessPath) {
      return false;
    }

    const ready = await checkReadiness(options.readiness);
    writeJson(
      response,
      ready ? 200 : 503,
      healthPayload(options.service, ready ? "ready" : "not_ready"),
    );
    return true;
  };
}

/**
 * A server whose only routes are the liveness and readiness probes.
 * Always-on processes with no HTTP surface of their own (worker, supervisor)
 * run this so the container healthcheck asks the process a question rather
 * than guessing from outside.
 */
export function createHealthServer(options: HealthEndpointOptions): Server {
  const listener = createHealthListener(options);
  const readiness = createReadinessListener(options);

  return createServer((request, response) => {
    void (async () => {
      if (listener(request, response) || (await readiness(request, response))) {
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }

      response.end(JSON.stringify({ error: "internal_error" }));
    });
  });
}
