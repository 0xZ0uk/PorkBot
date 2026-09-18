import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { moduleInfo as contractsModule } from "@porkbot/contracts";
import { moduleInfo as coreModule } from "@porkbot/core";
import { healthPath } from "@porkbot/health";
import { createLogger, moduleInfo as loggingModule, redactPath } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { appImplementer } from "./routers/context.ts";
import { createDeploymentRouter } from "./routers/deployment.ts";
import type { DeploymentStatusService } from "./services/deployment.ts";

export const serviceName = "@porkbot/api";

/** The path the RPC protocol is mounted on. */
export const rpcPath = "/rpc";

/**
 * The services a router may delegate to. The app takes them as an argument so
 * `main.ts` is the composition root and a test can hand in a fake for the one
 * service under test without a database or a network.
 */
export interface ApiServices {
  readonly deployment: DeploymentStatusService;
}

export interface ApiAppOptions {
  readonly services: ApiServices;
  /** Defaults to a JSON logger for this service. */
  readonly logger?: Logger;
  /** Request id factory used when the client did not supply one. */
  readonly generateRequestId?: () => string;
}

interface ApiEnv {
  Variables: {
    logger: Logger;
    requestId: string;
  };
}

export type ApiApp = Hono<ApiEnv>;

/**
 * The API's HTTP surface: one Hono app with the request boundary, the health
 * probe, and the oRPC handler mounted on `/rpc`. Routers live in `routers/`,
 * delegate to the injected services, and contain no business logic.
 */
export function createApiApp(options: ApiAppOptions): ApiApp {
  const logger = options.logger ?? createLogger({ service: serviceName });
  const generateRequestId = options.generateRequestId ?? randomUUID;
  const router = appImplementer.router({
    deployment: createDeploymentRouter(options.services.deployment),
  });
  const rpc = new RPCHandler(router, {
    interceptors: [
      onError((error, context) => {
        // A declared error is part of the contract and the caller's business;
        // the request line already carries its status. Anything else is a
        // defect, logged redacted and answered 500 by oRPC.
        if (error instanceof ORPCError && error.defined) {
          return;
        }

        context.context.logger.error("request failed", {
          error,
          path: redactPath(requestPath(context.request.url)),
        });
      }),
    ],
  });

  const app = new Hono<ApiEnv>();

  app.use("*", requestBoundary(logger, generateRequestId));

  app.get(healthPath, (context) =>
    context.json({
      status: "ok",
      service: serviceName,
      modules: [coreModule.name, contractsModule.name, loggingModule.name],
    }),
  );

  app.use(`${rpcPath}/*`, async (context, next) => {
    const { matched, response } = await rpc.handle(context.req.raw, {
      prefix: rpcPath,
      context: {
        logger: context.get("logger"),
        requestId: context.get("requestId"),
      },
    });

    if (matched) {
      return context.newResponse(response.body, response);
    }

    return next();
  });

  app.notFound((context) => context.json({ error: "not_found" }, 404));

  // Hono handles a thrown error at the dispatch that raised it, before the
  // boundary middleware can see it, so the error line and the 500 body live
  // here rather than in `requestBoundary`'s catch (which stays as a backstop
  // for an error handler that itself fails). `context.get("logger")` is unset
  // only if the boundary failed before it could build one.
  app.onError((error, context) => {
    const requestLogger = context.get("logger") ?? logger;

    requestLogger.error("request failed", {
      error,
      method: context.req.method,
      path: redactPath(requestPath(context.req.raw.url)),
    });

    return context.json({ error: "internal_error" }, 500);
  });

  return app;
}

function requestPath(url: string | URL): string {
  const parsed = url instanceof URL ? url : new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * The first non-blank id wins, so a proxy that repeats the header cannot
 * replace an id a client already chose with its own.
 */
function requestIdFor(header: string | undefined, generate: () => string): string {
  for (const candidate of (header ?? "").split(",")) {
    const trimmed = candidate.trim();

    if (trimmed !== "") {
      return trimmed;
    }
  }

  return generate();
}

/**
 * The request boundary, registered before any route: every finished response
 * gets a correlation id, a request line (redacted, with the status deciding
 * the level) and, if the handler threw, an error line. It is the listener's
 * job rather than a per-route middleware so it cannot be forgotten, and its
 * catch is a backstop for a failure in the error handler itself; an ordinary
 * handler error is answered by `onError` and still gets its request line here.
 */
function requestBoundary(baseLogger: Logger, generateRequestId: () => string) {
  return async (context: Context<ApiEnv>, next: Next): Promise<void> => {
    const startedAt = performance.now();
    const method = context.req.method;
    const path = requestPath(context.req.raw.url);
    let requestLogger = baseLogger;
    let status = 500;

    try {
      const requestId = requestIdFor(context.req.header("x-request-id"), generateRequestId);
      requestLogger = baseLogger.child({ requestId });
      context.set("logger", requestLogger);
      context.set("requestId", requestId);
      context.header("x-request-id", requestId);

      await next();
      status = context.res.status;
    } catch (error) {
      requestLogger.error("request failed", {
        error,
        method,
        path: redactPath(path),
      });
      context.res = context.json({ error: "internal_error" }, 500);
    } finally {
      requestLogger.request({
        method,
        path,
        status,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  };
}
