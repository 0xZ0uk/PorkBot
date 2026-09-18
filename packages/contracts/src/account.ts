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
