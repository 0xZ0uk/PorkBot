import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The account module: who the signed-in actor is.
 *
 * `account.me` exists to make the gate observable from a client: it is the
 * first authenticated procedure, so a web shell can distinguish "signed out"
 * (the gate's typed 401) from "signed in". It echoes the actor's own scope and
 * role and nothing else — no tenant id is accepted as input anywhere in the
 * contract, and the handler has no way to read a scope other than the actor's.
 */

/** The membership roles a `space_member` row allows. */
export const memberRoleSchema = z.enum(["owner", "member"]);

export type MemberRole = z.infer<typeof memberRoleSchema>;

export const accountMeContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/account/me",
    operationId: "accountMe",
    summary: "The signed-in actor and the space it acts in",
  })
  .output(
    z.object({
      spaceId: z.string().min(1),
      userId: z.string().min(1),
      role: memberRoleSchema,
    }),
  );

/**
 * The deployment's ownership facts, for the account settings surface (slice
 * 11.5; PRD decision 8; story 3). `account.me` answers who the caller is;
 * this answers who owns the deployment they are signed in to.
 *
 * `ownerEmail` is the configured admin address, or `null` when the operator
 * never named one — a deployment whose signups are open with no owner is a
 * real state, and `null` says exactly that rather than hiding the row. It is
 * deployment configuration, not a credential: the value is an address the
 * operator configured for themselves, never secret material.
 *
 * The read is authenticated because it is deployment state an anonymous
 * caller has no business enumerating; no input names a space, a user or the
 * settings row, so a caller can only ever read the deployment it is signed
 * in to.
 */
export const accountOwnershipContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/account/ownership",
    operationId: "accountOwnership",
    summary: "The actor's role and the deployment's configured owner",
  })
  .errors({
    /**
     * The deployment's settings rows disagree with each other, so "who owns
     * this deployment?" has no single answer. The detailed value reaches the
     * redacted server log; the client is told only that the question cannot be
     * answered right now.
     */
    SERVICE_UNAVAILABLE: {
      status: 503,
      message: "The deployment's ownership configuration is not readable",
    },
  })
  .output(
    z.object({
      role: memberRoleSchema,
      /** Bounded like an email column, so an oversized value is refused. */
      ownerEmail: z.string().max(320).nullable(),
    }),
  );
