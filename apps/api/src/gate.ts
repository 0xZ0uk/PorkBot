import { createORPCErrorConstructorMap, implement } from "@orpc/server";
import type { ErrorMap, Router } from "@orpc/server";
import { appContract } from "@porkbot/contracts";
import type { AppContract } from "@porkbot/contracts";
import { mapError } from "@porkbot/effect";
import type { UserActor, UserRepositories } from "@porkbot/db";
import type { Logger } from "@porkbot/logging";
import type { ResolveActor } from "@porkbot/auth";

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
 */
export interface ProcedureContext {
  readonly logger: Logger;
  readonly requestId: string;
  readonly actor: UserActor | null;
  readonly repositories: UserRepositories | null;
}

export interface OpenContextOptions {
  readonly headers: Headers;
  readonly logger: Logger;
  readonly requestId: string;
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
  };
}

/**
 * The error map an authenticated procedure is required to carry: the gate can
 * answer `UNAUTHORIZED` for any of them, and `access.test.ts` in
 * `@porkbot/contracts` fails when one forgets. The cast below is what lets the
 * shared middleware construct the procedure's own declared error at runtime
 * without widening the context type for every public procedure.
 */
type AuthenticatedErrorMap = ErrorMap & {
  readonly UNAUTHORIZED: { readonly status?: number; readonly message?: string };
};

function misregistration(path: string, realm: "authenticated" | "public"): Error {
  return new Error(
    `${path} is misregistered: it must be implemented through the "${realm}" implementer ` +
      `that matches its access marker. See apps/api/src/gate.ts.`,
  );
}

const baseImplementer = implement(appContract).$context<ProcedureContext>();

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
export const authenticated = baseImplementer
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
export const publicOnly = baseImplementer
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
