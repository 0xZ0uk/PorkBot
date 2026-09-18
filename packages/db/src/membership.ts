import { asc, eq } from "drizzle-orm";
import type { UserActor } from "./actor.ts";
import type { PostgresDatabase } from "./database.ts";
import { spaceMember } from "./schema/tenancy.ts";

/**
 * The actor a session's user id resolves to, or `null` when there is none.
 *
 * This is the read half of the single auth gate (PRD decision 7): the gate in
 * `@porkbot/auth` reads the session, takes the user id the session reports, and
 * asks this function for the membership. It takes a user id from the session
 * and never a space id, so a caller cannot choose the space — the membership
 * row is the authorization root, and an id whose membership was deleted
 * resolves to `null` (the gate answers 401) rather than to an invented scope.
 *
 * It is the third and last deliberately pre-actor path in this package, beside
 * `readDeploymentSettings` and `bootstrapSignup`: a session exists before any
 * repository call does, and the gate itself cannot be built from an actor. The
 * ordering is fixed — oldest membership first, then id — so a future user with
 * more than one membership resolves the same actor on every call; v1.0's
 * bootstrap writes exactly one.
 */
export interface ResolveActorInput {
  readonly userId: string;
}

export async function resolveUserActor(
  database: PostgresDatabase,
  input: ResolveActorInput,
): Promise<UserActor | null> {
  const rows = await database
    .select({ spaceId: spaceMember.spaceId, role: spaceMember.role })
    .from(spaceMember)
    .where(eq(spaceMember.userId, input.userId))
    .orderBy(asc(spaceMember.createdAt), asc(spaceMember.id))
    .limit(1);

  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  return { kind: "user", spaceId: row.spaceId, userId: input.userId, role: row.role };
}
