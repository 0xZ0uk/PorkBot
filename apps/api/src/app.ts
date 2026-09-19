import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { moduleInfo as contractsModule } from "@porkbot/contracts";
import { moduleInfo as coreModule } from "@porkbot/core";
import { createOpenAiCompatibleModelRuntime } from "@porkbot/adapters";
import {
  boundaryReports,
  mapError,
  webhookDeliveryHeader,
  webhookSignatureHeader,
} from "@porkbot/effect";
import { healthPath } from "@porkbot/health";
import { createLogger, moduleInfo as loggingModule, redactPath } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import type { ResolveActor } from "@porkbot/auth";
import type {
  CredentialStore,
  ModelRuntimeProvider,
  RealtimeFanout,
  StorageProvider,
} from "@porkbot/adapter-kit";
import type { UserActor, UserRepositories } from "@porkbot/db";
import { assembleRouter, openProcedureContext } from "./gate.ts";
import { createCursorCodec } from "./cursors.ts";
import { httpRateLimited, installLimits, resolveLimits, routeRules } from "./limits.ts";
import type { LimitEnv, LimitPrincipal, LimitsOverrides } from "./limits.ts";
import { createAccountRouter } from "./routers/account.ts";
import { createApprovalsRouter } from "./routers/approvals.ts";
import { createBotSecretsRouter } from "./routers/bot-secrets.ts";
import { createBotsRouter } from "./routers/bots.ts";
import { createComputersRouter } from "./routers/computers.ts";
import { createCredentialsRouter } from "./routers/credentials.ts";
import { createDeploymentRouter } from "./routers/deployment.ts";
import { createMcpRouter } from "./routers/mcp.ts";
import { createMemoryRouter } from "./routers/memory.ts";
import { createModelConnectionsRouter } from "./routers/model-connections.ts";
import { createNotificationsRouter } from "./routers/notifications.ts";
import { createRoutinesRouter } from "./routers/routines.ts";
import { createRunsRouter } from "./routers/runs.ts";
import { createSectionsRouter } from "./routers/sections.ts";
import { createThreadsRouter } from "./routers/threads.ts";
import { createUsageRouter } from "./routers/usage.ts";
import { createBotService } from "./services/bots.ts";
import { createComputerService, unconfiguredComputerProvider } from "./services/computers.ts";
import type { ComputerLifecycleProvider } from "./services/computers.ts";
import type { DeploymentStatusService } from "./services/deployment.ts";
import { mcpCallbackPath } from "./services/mcp.ts";
import type { McpService } from "./services/mcp.ts";
import {
  attachmentUploadPath,
  contentDisposition,
  createFileService,
  fileDownloadPath,
  toReadableStream,
} from "./services/files.ts";
import { createModelConnectionsService } from "./services/model-connections.ts";
import { createThreadEventsService } from "./services/thread-events.ts";
import { createThreadsService } from "./services/threads.ts";
import { refuseWebhooks, webhookPath } from "./webhooks.ts";
import type { WebhookIngress, WebhookOutcome } from "./webhooks.ts";

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
  /**
   * The live wake-up source for thread subscriptions. Process-scoped, like a
   * pool or an SDK client: one instance serves every request, and a same-process
   * publisher wakes the API through it. Durable events are read from the
   * actor's repositories, so a lost signal is latency rather than a lost event.
   */
  readonly realtime: RealtimeFanout;
  /**
   * Where a bot's avatar bytes live. Optional so a test app that never touches
   * an avatar needs no directory, but a process that answers `bots.setAvatar`
   * must supply one: the default refuses, and the refusal is a defect answered
   * 500 with a redacted line rather than a silent write to a second path.
   * `main.ts` supplies the local-filesystem provider rooted at
   * `PORKBOT_STORAGE_DIR`.
   */
  readonly storage?: StorageProvider;
  /**
   * MCP install, OAuth completion and discovery (slice 9.5). Optional so a
   * test app that never installs a server needs no provider or keyring; the
   * list, get, grant and revoke procedures read the durable store and work
   * without it, while `create` refuses as a miscomposition when it is absent.
   * `main.ts` supplies the real service over the HTTP provider and the ingress
   * state ledger.
   */
  readonly mcp?: McpService;
  /**
   * Builds the model runtime a probe uses for one request over the actor's
   * credential store (slice 9.2). The default is the shipped
   * OpenAI-compatible provider over the URL-safety transport; a test injects
   * the emulator-backed one, so the probe suite crosses a real wire with no
   * network and no key.
   */
  readonly modelRuntime?: (credentials: CredentialStore) => ModelRuntimeProvider;
  /**
   * The supervisor client (slice 7.1). The API holds no Docker socket and no
   * provider credential: this is an authenticated HTTP client for the
   * supervisor's lifecycle surface, and `main.ts` builds it from
   * `PORKBOT_SUPERVISOR_URL` and `PORKBOT_SUPERVISOR_TOKEN`. The default
   * refuses as the typed `SERVICE_UNAVAILABLE`, so an unconfigured deployment
   * says so instead of pretending a computer is gone.
   */
  readonly computers?: ComputerLifecycleProvider | undefined;
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
  /**
   * Overrides for the rate limits, body caps and stream caps in
   * `./limits.ts`. Unset fields take the registered defaults; `main.ts`
   * supplies operator values from the environment.
   */
  readonly limits?: LimitsOverrides;
  /**
   * The client address a request is keyed by when no actor resolved. It
   * defaults to one shared "unknown" key, which is fail-closed (all anonymous
   * clients share a budget); `createApiServer` supplies the socket address.
   */
  readonly clientKey?: (context: Context<ApiEnv>) => string;
  /**
   * The HMAC key resumable cursors are signed with. It defaults to a
   * per-process random key, so a restart invalidates outstanding cursors and a
   * client resumes from zero; supply one only to share cursors across
   * processes. Cursors are bound to the actor, the space and the thread.
   */
  readonly cursorSecret?: string | Uint8Array;
  /**
   * The verified webhook ingress (slice 4.5). It is injected like the session
   * resolver rather than built here, so a test hands in a fake and `main.ts`
   * composes the real one over the credential store and the ingress ledgers.
   * The default refuses every request: the route is always mounted and
   * declared, and an unconfigured process dispatches nothing.
   */
  readonly webhooks?: WebhookIngress;
}

interface ApiEnv extends LimitEnv {
  Variables: {
    logger: Logger;
    requestId: string;
    principal: LimitPrincipal | undefined;
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
  const clientKey = options.clientKey ?? (() => "unknown");
  const threadEvents = createThreadEventsService({
    realtime: options.services.realtime,
    cursors: createCursorCodec(options.cursorSecret),
  });
  const threads = createThreadsService();
  const webhooks = options.webhooks ?? refuseWebhooks(logger);
  const storage = options.services.storage ?? refuseStorage();
  const files = createFileService(storage);
  const modelRuntime =
    options.services.modelRuntime ??
    ((credentials: CredentialStore) => createOpenAiCompatibleModelRuntime({ credentials }));
  const router = assembleRouter({
    deployment: createDeploymentRouter(options.services.deployment),
    account: createAccountRouter(),
    approvals: createApprovalsRouter(),
    notifications: createNotificationsRouter(),
    bots: createBotsRouter(
      createBotService(storage),
      createComputerService(options.services.computers ?? unconfiguredComputerProvider()),
    ),
    botSecrets: createBotSecretsRouter(),
    computers: createComputersRouter(
      createComputerService(options.services.computers ?? unconfiguredComputerProvider()),
    ),
    sections: createSectionsRouter(),
    threads: createThreadsRouter(threadEvents, threads),
    runs: createRunsRouter(),
    routines: createRoutinesRouter(),
    memory: createMemoryRouter(),
    usage: createUsageRouter(),
    credentials: createCredentialsRouter(),
    mcpServers: createMcpRouter(options.services.mcp),
    modelConnections: createModelConnectionsRouter(
      createModelConnectionsService({ runtime: modelRuntime }),
    ),
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

  // The one place limits, body caps and stream caps are installed. It is
  // registered before every route, so a route added below — or by a test —
  // cannot be silently unlimited.
  const limits = installLimits(app, {
    config: resolveLimits(options.limits),
    rules: routeRules(rpcPath),
    clientKey,
  });

  app.get(healthPath, (context) =>
    context.json({
      status: "ok",
      service: serviceName,
      modules: [coreModule.name, contractsModule.name, loggingModule.name],
    }),
  );

  // The OAuth callback (slice 9.5). It arrives in the operator's browser with
  // no session of its own, so the one-time state is the capability: the service
  // consumes it, re-reads the initiating membership inside the binding's space
  // and answers the typed refusal for a replayed, foreign or missing one. No
  // actor is fabricated here, and the response never carries a token.
  app.get(mcpCallbackPath, async (context) => {
    const service = options.services.mcp;

    if (service === undefined) {
      return context.json({ error: "internal_error" }, 500);
    }

    try {
      const result = await service.completeAuthorization(
        context.req.query("state") ?? "",
        context.req.query("code"),
      );

      return context.json({ status: "connected", serverId: result.server.id }, 200);
    } catch (error) {
      const mapped = mapError(error);

      return new Response(JSON.stringify({ error: mapped.error.code }), {
        status: mapped.error.status,
        headers: { "content-type": "application/json" },
      });
    }
  });

  // The one unauthenticated write surface (slice 4.5). It reads the raw bytes
  // and hands them to the ingress, which verifies the signature before
  // anything parses them; no session is read here, so the request runs under
  // the client's anonymous principal and no actor is fabricated for it. The
  // body cap the limiter installed for the `webhook` family has already run.
  app.post(webhookPath, async (context) => {
    const outcome = await webhooks.receive({
      source: context.req.param("source"),
      signature: context.req.header(webhookSignatureHeader),
      deliveryId: context.req.header(webhookDeliveryHeader),
      body: new Uint8Array(await context.req.arrayBuffer()),
    });

    return webhookResponse(context, outcome);
  });

  // The attachment upload (slice 7.6, story 32). It is a raw route rather than
  // an RPC procedure because the bytes are the point: the body streams into
  // the storage seam without ever becoming JSON, the `upload` family's cap has
  // already refused an oversized request, and the session is read exactly once
  // through the gate's `openProcedureContext` before any store is touched. The
  // file name rides the query, the content type the header, and the answer is
  // the row the send will address.
  app.post(attachmentUploadPath, async (context) => {
    const procedureContext = await openProcedureContext({
      headers: context.req.raw.headers,
      logger: context.get("logger"),
      requestId: context.get("requestId"),
      clientKey: clientKey(context),
      limits,
      resolveActor,
      repositoriesFor,
    });

    if (procedureContext.actor === null || procedureContext.repositories === null) {
      return context.json({ error: "unauthorized" }, 401);
    }

    const filename = context.req.query("filename") ?? "";

    if (filename.trim() === "") {
      return context.json({ error: "bad_request", message: "filename is required" }, 400);
    }

    try {
      const uploaded = await files.upload({
        repositories: procedureContext.repositories,
        threadId: context.req.param("threadId"),
        filename,
        contentType: context.req.header("content-type") ?? "",
        body: uploadBody(context.req.raw),
      });

      return context.json(uploaded, 201);
    } catch (error) {
      return errorResponse(error);
    }
  });

  // The stored-file download (slice 7.6, stories 32 and 33). Attachment and
  // artifact ids share it: the row is the actor-scoped index, the storage seam
  // holds the bytes, and the response streams the object with its stored name.
  // The RPC family's actor budget is spent here after the gate resolved the
  // session, the same order the procedures use.
  app.get(fileDownloadPath, async (context) => {
    const procedureContext = await openProcedureContext({
      headers: context.req.raw.headers,
      logger: context.get("logger"),
      requestId: context.get("requestId"),
      clientKey: clientKey(context),
      limits,
      resolveActor,
      repositoriesFor,
    });

    if (procedureContext.actor === null || procedureContext.repositories === null) {
      return context.json({ error: "unauthorized" }, 401);
    }

    const outcome = limits.enforceRpc(procedureContext.principal);

    if (!outcome.allowed) {
      return httpRateLimited(context, outcome.retryAfterSeconds);
    }

    try {
      const file = await files.read({
        repositories: procedureContext.repositories,
        fileId: context.req.param("fileId"),
      });

      return new Response(toReadableStream(file.body), {
        status: 200,
        headers: {
          "content-type": file.contentType,
          "content-length": String(file.sizeBytes),
          "content-disposition": contentDisposition(file.filename),
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.use(`${rpcPath}/*`, async (context, next) => {
    // A failure here is before the oRPC boundary exists, so it cannot be a
    // typed procedure error: it is a defect, and Hono's error handler answers
    // it 500 with a redacted line (gate.test.ts locks that behavior).
    const procedureContext = await openProcedureContext({
      headers: context.req.raw.headers,
      logger: context.get("logger"),
      requestId: context.get("requestId"),
      clientKey: clientKey(context),
      limits,
      resolveActor,
      repositoriesFor,
    });

    const { matched, response } = await rpc.handle(context.req.raw, {
      prefix: rpcPath,
      context: procedureContext,
    });

    if (matched) {
      // The gate puts a header on a typed refusal (the 429's `Retry-After`)
      // without naming the transport; the RPC response is where it lands.
      context.set("principal", procedureContext.principal);

      procedureContext.responseHeaders.forEach((value, name) => response.headers.set(name, value));

      return context.newResponse(response.body, response);
    }

    // An RPC path the contract does not name draws the unmatched-path budget:
    // the gate's own limiter only runs once a procedure matched.
    const outcome = limits.enforceRoute("fallback", clientKey(context));

    if (!outcome.allowed) {
      return httpRateLimited(context, outcome.retryAfterSeconds);
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
 * The upload body as the storage seam wants it: the request's stream pulled
 * one chunk at a time, never buffered. A bodyless request yields nothing and
 * stores an empty object.
 */
async function* uploadBody(request: Request): AsyncIterable<Uint8Array> {
  const body = request.body;

  if (body === null) {
    return;
  }

  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        return;
      }

      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The typed refusal of a raw route. `mapError` is the same boundary the
 * procedures use, so a missing file and an unconfigured store answer the same
 * statuses here as they do over RPC; the detailed value stays in the request's
 * redacted error line, never in this body.
 */
function errorResponse(error: unknown): Response {
  const mapped = mapError(error);

  return new Response(JSON.stringify({ error: mapped.error.code }), {
    status: mapped.error.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The ingress answer. A replay is a 200 because the provider's redelivery is
 * acknowledged, not corrected; a refusal is a flat 401 that does not say which
 * check failed, so a probe cannot map the deployment's configuration. A missing
 * or over-long delivery id is the caller's 400 — that does tell a caller its
 * signature verified, which is acceptable because a caller holding a valid
 * signature already holds the source's secret. A handler failure is not
 * answered here: it is rethrown and answered 500 by the error handler so the
 * provider retries.
 */
function webhookResponse(context: Context<ApiEnv>, outcome: WebhookOutcome): Response {
  switch (outcome.status) {
    case "accepted":
      return context.json({ status: "accepted" }, 202);
    case "duplicate":
      return context.json({ status: "ignored" }, 200);
    case "rejected":
      return outcome.reason === "missing_delivery" || outcome.reason === "invalid_delivery"
        ? context.json({ error: "bad_request" }, 400)
        : context.json({ error: "unauthorized" }, 401);
  }
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
 * The default storage provider: no avatar operation can succeed without one,
 * and every one of them says so. A construction that never configures storage
 * is a miscomposition, so the refusal is a defect (answered 500 and logged
 * redacted), not a typed client error; the alternative — a silent fallback
 * directory — would be the second storage path this feature exists to prevent.
 */
function refuseStorage(): StorageProvider {
  const refuse = (): never => {
    throw new Error(
      "storage is not configured for this process; supply a StorageProvider in services.",
    );
  };

  return {
    put: refuse,
    get: refuse,
    delete: refuse,
    list: refuse,
  };
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
