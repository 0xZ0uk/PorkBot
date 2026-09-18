import { oc } from "@orpc/contract";
import { z } from "zod";

/**
 * Procedure access: authenticated unless explicitly marked public.
 *
 * PRD decision 7 makes authorization structure rather than discipline: a
 * handler runs with an actor-scoped repository, and the only way to run
 * without one is to say so in the contract. Every procedure therefore carries
 * its access in metadata — `authenticatedProcedure` for the default,
 * `publicProcedure` for the deliberate exception — and the API's gate checks
 * the marker before a handler runs (see `apps/api/src/gate.ts`).
 *
 * `authenticatedProcedure` also declares the gate's `UNAUTHORIZED` error, so a
 * signed-out client sees the 401 as part of the procedure's typed errors
 * instead of an opaque failure. A public procedure declares no such error: the
 * gate never rejects it. Every procedure — public or authenticated — declares
 * `RATE_LIMITED`, because the gate's limiter runs before the access decision so
 * that an unauthenticated flood is capped before it reaches a session read.
 * `access.test.ts` walks the contract tree and fails when a procedure carries
 * no marker, when the public list drifts from the tree, when an authenticated
 * procedure forgets the 401, or when any procedure forgets the 429.
 */

export const procedureAccessSchema = z.enum(["authenticated", "public"]);

export type ProcedureAccess = z.infer<typeof procedureAccessSchema>;

/** The metadata every contract procedure carries; the gate reads it. */
export interface ProcedureMeta {
  readonly access: ProcedureAccess;
}

const authenticatedMeta = { access: "authenticated" } as const satisfies ProcedureMeta;

const publicMeta = { access: "public" } as const satisfies ProcedureMeta;

/**
 * How long a caller should wait before retrying a limited procedure, in whole
 * seconds. It is both the HTTP `Retry-After` header value and the error's
 * `data`, so a typed client does not have to parse a header to back off.
 */
export const rateLimitedDataSchema = z.object({
  retryAfterSeconds: z.number().int().min(1),
});

export type RateLimitedData = z.infer<typeof rateLimitedDataSchema>;

/**
 * One message for the typed error and for the plain-HTTP 429 a streaming or
 * webhook response can be refused with, so a caller sees the same sentence
 * whichever surface answered.
 */
export const rateLimitedErrorMessage = "Too many requests; retry after the given delay";

/**
 * Declared by every procedure: a request budget and a per-actor stream budget
 * are enforced in the gate for the whole contract, so the error is part of
 * every procedure's typed surface rather than a surprise for a new one.
 */
const rateLimitError = {
  RATE_LIMITED: {
    status: 429,
    message: rateLimitedErrorMessage,
    data: rateLimitedDataSchema,
  },
} as const;

/**
 * The default: a procedure whose handler receives an `Actor` and repositories
 * scoped to that actor's space. The gate answers `UNAUTHORIZED` before the
 * handler runs when the request carries no session or the session's user has no
 * membership, so the error is declared here rather than in each module.
 */
export const authenticatedProcedure = oc.$meta(authenticatedMeta).errors({
  UNAUTHORIZED: {
    status: 401,
    message: "Sign in to continue",
  },
  ...rateLimitError,
});

/**
 * The explicit act: a procedure that runs before a session exists, such as
 * signup availability. Marking one is a two-file change by design — this
 * builder here and the `publicProcedures` inventory in `contract.ts` — so a
 * new public surface is visible in review instead of implied by omission. It
 * declares no `UNAUTHORIZED` (the gate never rejects it) but does declare
 * `RATE_LIMITED`: anonymous callers are capped per client address.
 */
export const publicProcedure = oc.$meta(publicMeta).errors(rateLimitError);
