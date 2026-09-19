import { and, asc, eq } from "drizzle-orm";
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

/** The space and user a pre-actor binding names. */
export interface BoundActorInput {
  readonly spaceId: string;
  readonly userId: string;
}

/**
 * The actor a one-time binding names, or `null` when that membership is gone.
 *
 * This is the OAuth callback's resolver (slice 9.5). Unlike `resolveUserActor`,
 * the space is not chosen by a caller: it comes from the `oauth_state` row,
 * which was written from the initiating actor when the flow was issued. The
 * read is the membership itself, so a revocation between install and callback
 * resolves to `null` and the flow is refused before anything is written — the
 * same authorization root the gate uses, asked with the binding's scope.
 */
export async function resolveBoundActor(
  database: PostgresDatabase,
  input: BoundActorInput,
): Promise<UserActor | null> {
  const rows = await database
    .select({ role: spaceMember.role })
    .from(spaceMember)
    .where(and(eq(spaceMember.spaceId, input.spaceId), eq(spaceMember.userId, input.userId)))
    .limit(1);

  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  return { kind: "user", spaceId: input.spaceId, userId: input.userId, role: row.role };
}
