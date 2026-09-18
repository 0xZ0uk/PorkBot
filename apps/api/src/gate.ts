import { createORPCErrorConstructorMap, implement } from "@orpc/server";
import type { ErrorMap, Router } from "@orpc/server";
import { appContract } from "@porkbot/contracts";
import type { AppContract, rateLimitedDataSchema } from "@porkbot/contracts";
import { mapError } from "@porkbot/effect";
import type { UserActor, UserRepositories } from "@porkbot/db";
import type { Logger } from "@porkbot/logging";
import type { ResolveActor } from "@porkbot/auth";
import { actorPrincipal, clientPrincipal } from "./limits.ts";
import type { LimitPrincipal, RateLimits } from "./limits.ts";

/**
 * The single auth gate (PRD decision 7).
 *
 * One request enters `openProcedureContext`, which reads the session once
 * through the injected `ResolveActor`, resolves the membership to an `Actor`,
 * and builds the actor-scoped repositories that are the only data access a
 * handler can reach. `ProcedureContext` carries that outcome; it never carries
 * a raw database, and no contract input names a space.
 *
 * Two implementers hang off one contract, so access is a property of
 * registration rather than of remembering to run a guard:
 *
 *   - `authenticated` is the default. Its middleware refuses a request with no
 *     actor with the procedure's own typed `UNAUTHORIZED` and hands the handler
 *     a narrowed context whose `actor` and `repositories` are non-null.
 *   - `publicOnly` is the deliberate exception. Its middleware fails closed
 *     unless the contract marks the procedure public, so a procedure cannot
 *     reach the wire without a session unless `publicProcedure` said so in
 *     `@porkbot/contracts`.
 *
 * `implement(...)` is called here and nowhere else in `apps/api`; the lint rule
 * in `packages/eslint-config/auth-gate.js` fails a router that registers
 * procedures off this path. `assembleRouter` is the one assembly point: the
 * root router is still checked against `appContract`, so adding a procedure
 * fails the build until a router implements it.
 */

/**
 * The per-request context. Before the gate middleware runs, `actor` and
 * `repositories` are null for an anonymous request; after it, the authenticated
 * implementer narrows both to non-null for the handler.
 *
 * `principal` is the key the rate limiter and the stream slots account
 * against, `limits` is the process-wide accounting object, and
 * `responseHeaders` is the channel a middleware uses to add a header (the 429's
 * `Retry-After`) to whatever response the procedure produces.
 */
export interface ProcedureContext {
  readonly logger: Logger;
  readonly requestId: string;
  readonly actor: UserActor | null;
  readonly repositories: UserRepositories | null;
  readonly principal: LimitPrincipal;
  readonly limits: RateLimits;
  readonly responseHeaders: Headers;
}

export interface OpenContextOptions {
  readonly headers: Headers;
  readonly logger: Logger;
  readonly requestId: string;
  /** The client address, for the anonymous budget and the stream cap. */
  readonly clientKey: string;
  readonly limits: RateLimits;
  readonly resolveActor: ResolveActor;
  readonly repositoriesFor: (actor: UserActor) => UserRepositories;
}

/**
 * The one place in `apps/api` a session is read. The resolver owns the cookie
 * and the membership lookup; this function only composes its outcome into the
 * procedure context, and every request (public or not) goes through it exactly
 * once.
 */
export async function openProcedureContext(options: OpenContextOptions): Promise<ProcedureContext> {
  const actor = await options.resolveActor(options.headers);

  return {
    logger: options.logger,
    requestId: options.requestId,
    actor,
    repositories: actor === null ? null : options.repositoriesFor(actor),
    principal: actor === null ? clientPrincipal(options.clientKey) : actorPrincipal(actor),
    limits: options.limits,
    responseHeaders: new Headers(),
  };
}

/**
 * The error maps a procedure is required to carry. An authenticated procedure
 * declares `UNAUTHORIZED`; every procedure, public or not, declares
 * `RATE_LIMITED` because the limiter middleware below runs before the access
 * decision. `access.test.ts` in `@porkbot/contracts` fails when a builder stops
 * declaring either. The casts are what let the shared middleware construct the
 * procedure's own declared error at runtime without widening the context type
 * for every public procedure.
 */
type AuthenticatedErrorMap = ErrorMap & {
  readonly UNAUTHORIZED: { readonly status?: number; readonly message?: string };
};

type RateLimitedErrorMap = ErrorMap & {
  readonly RATE_LIMITED: {
    readonly status?: number;
    readonly message?: string;
    readonly data: typeof rateLimitedDataSchema;
  };
};

function misregistration(path: string, realm: "authenticated" | "public"): Error {
  return new Error(
    `${path} is misregistered: it must be implemented through the "${realm}" implementer ` +
      `that matches its access marker. See apps/api/src/gate.ts.`,
  );
}

const baseImplementer = implement(appContract).$context<ProcedureContext>();

/**
 * The one rate-limit decision for the contract. It is registered before the
 * access middleware on purpose: a flood is capped before the access check and
 * before any handler work, and a public procedure answers the same 429 as an
 * authenticated one. The budget is the actor's for a resolved session and the
 * client address's otherwise, so one actor cannot spend another's. The refusal
 * is an oRPC error, so it travels through `errorBoundary` untouched.
 */
const limited = baseImplementer.use(async ({ context, next, procedure }) => {
  const outcome = context.limits.enforceRpc(context.principal);

  if (!outcome.allowed) {
    const { errorMap } = procedure["~orpc"];
    const errors = createORPCErrorConstructorMap(errorMap as RateLimitedErrorMap);

    context.responseHeaders.set("retry-after", String(outcome.retryAfterSeconds));
    throw errors.RATE_LIMITED({ data: { retryAfterSeconds: outcome.retryAfterSeconds } });
  }

  return next();
});

/**
 * The transport error boundary (PRD decision 28), applied inside the gate's
 * access middleware so a misregistration or a typed 401 the gate itself raises
 * is not remapped. Anything a handler or a service throws passes through
 * `mapError` in `@porkbot/effect`: a typed error becomes the procedure's
 * declared envelope, and an unmapped defect becomes a 500 whose detailed value
 * travels only to the API's redacted error line. A router therefore never
 * inspects a raw error — it throws one and the boundary answers it.
 */
const errorBoundary = baseImplementer.middleware(async ({ next, procedure }) => {
  try {
    return await next();
  } catch (error) {
    const { errorMap } = procedure["~orpc"];

    throw mapError(error, {
      declaredFor: (code) => errorMap[code],
    }).error;
  }
});

/** The default path: an actor and actor-scoped repositories, or a typed 401. */
export const authenticated = limited
  .use(async ({ context, next, procedure }) => {
    const { route, meta, errorMap } = procedure["~orpc"];
    const path = route.path ?? "an unnamed procedure";

    if (meta.access !== "authenticated") {
      throw misregistration(path, "authenticated");
    }

    if (context.actor === null || context.repositories === null) {
      throw createORPCErrorConstructorMap(errorMap as AuthenticatedErrorMap).UNAUTHORIZED();
    }

    return next({
      context: { actor: context.actor, repositories: context.repositories },
    });
  })
  .use(errorBoundary);

/** The explicit exception: only a contract marked `publicProcedure` gets here. */
export const publicOnly = limited
  .use(async ({ next, procedure }) => {
    const { route, meta } = procedure["~orpc"];
    const path = route.path ?? "an unnamed procedure";

    if (meta.access !== "public") {
      throw misregistration(path, "public");
    }

    return next();
  })
  .use(errorBoundary);

/**
 * Assembles the root router from the per-domain routers and checks it against
 * the contract once, so a contract procedure with no implementation fails the
 * build. Domain routers come from `authenticated` or `publicOnly`; this
 * function never accepts an ungated procedure because it is the only caller of
 * `baseImplementer.router`.
 */
export function assembleRouter(router: Router<AppContract, ProcedureContext>) {
  return baseImplementer.router(router);
}
