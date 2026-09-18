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
 * gate never rejects it. `access.test.ts` walks the contract tree and fails
 * when a procedure carries no marker, when the public list drifts from the
 * tree, or when an authenticated procedure forgets the 401.
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
});

/**
 * The explicit act: a procedure that runs before a session exists, such as
 * signup availability. Marking one is a two-file change by design — this
 * builder here and the `publicProcedures` inventory in `contract.ts` — so a
 * new public surface is visible in review instead of implied by omission.
 */
export const publicProcedure = oc.$meta(publicMeta);
