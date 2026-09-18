import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { moduleInfo as contractsModule } from "@porkbot/contracts";
import { moduleInfo as coreModule } from "@porkbot/core";
import { boundaryReports } from "@porkbot/effect";
import { healthPath } from "@porkbot/health";
import { createLogger, moduleInfo as loggingModule, redactPath } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import type { ResolveActor } from "@porkbot/auth";
import type { UserActor, UserRepositories } from "@porkbot/db";
import { assembleRouter, openProcedureContext } from "./gate.ts";
import { createAccountRouter } from "./routers/account.ts";
import { createBotsRouter } from "./routers/bots.ts";
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
  /**
   * The one session read the gate composes (slice 3.2), from
   * `createActorResolver` in `@porkbot/auth`. The default answers "no session",
   * so a process without operator auth configuration boots fail-closed:
   * public procedures work, and every authenticated procedure answers its
   * typed 401 rather than seeing an invented actor.
   */
  readonly resolveActor?: ResolveActor;
  /**
   * Builds the actor-scoped repositories for one request. The default refuses;
   * it is unreachable while the default resolver answers "no session", and
   * refusing is the safe direction once a resolver is configured without a
   * data scope.
   */
  readonly repositoriesFor?: (actor: UserActor) => UserRepositories;
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
 * register through the gate in `gate.ts`, delegate to the injected services,
 * and contain no business logic.
 */
export function createApiApp(options: ApiAppOptions): ApiApp {
  const logger = options.logger ?? createLogger({ service: serviceName });
  const generateRequestId = options.generateRequestId ?? randomUUID;
  const resolveActor = options.resolveActor ?? noSession;
  const repositoriesFor = options.repositoriesFor ?? refuseRepositories;
  const router = assembleRouter({
    deployment: createDeploymentRouter(options.services.deployment),
    account: createAccountRouter(),
    bots: createBotsRouter(),
  });
  const rpc = new RPCHandler(router, {
    interceptors: [
      onError((error, context) => {
        // The gate's boundary mapping (PRD decision 28) answers every handler
        // error; what it left as a report is the only thing worth logging here,
        // and it is logged redacted with the request's correlation id. A
        // declared error is the caller's business and has an empty report.
        const reports = boundaryReports(error);
        const path = redactPath(requestPath(context.request.url));

        if (reports !== null) {
          for (const reported of reports) {
            context.context.logger.error("request failed", { error: reported, path });
          }

          return;
        }

        // An error the boundary never saw — a failure while building the
        // procedure context, or inside oRPC itself — is still a defect, logged
        // redacted and answered 500 by oRPC.
        if (error instanceof ORPCError && error.defined) {
          return;
        }

        context.context.logger.error("request failed", {
          error,
          path,
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
    // A failure here is before the oRPC boundary exists, so it cannot be a
    // typed procedure error: it is a defect, and Hono's error handler answers
    // it 500 with a redacted line (gate.test.ts locks that behavior).
    const procedureContext = await openProcedureContext({
      headers: context.req.raw.headers,
      logger: context.get("logger"),
      requestId: context.get("requestId"),
      resolveActor,
      repositoriesFor,
    });

    const { matched, response } = await rpc.handle(context.req.raw, {
      prefix: rpcPath,
      context: procedureContext,
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
 * The fail-closed default session read: no session, so no actor and every
 * authenticated procedure answers its typed 401. It is replaced by
 * `createActorResolver` when the process is given auth configuration.
 */
const noSession: ResolveActor = async () => null;

/** The default repository factory: unreachable now, and a refusal if reached. */
function refuseRepositories(): never {
  throw new Error(
    "actor-scoped repositories are not configured for this process; " +
      "supply repositoriesFor beside the session resolver.",
  );
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
