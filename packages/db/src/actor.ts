import type { spaceMemberRole } from "./schema/tenancy.ts";

/**
 * Who is asking, and in which space — the only scope a repository can be built
 * from.
 *
 * PRD decision 7 fixes the reference implementation's discipline-only
 * authorization: a handler never receives a tenant id, it receives a repository
 * that was constructed from an `Actor`, and every statement that repository
 * issues is bound to the actor's space. A `UserActor` is a session plus a
 * membership row (`space_member` is the authorization root); a `SystemActor` is
 * a background job's space, for the worker, which has no session and no user.
 *
 * The types below are the whole enforcement surface: a repository factory takes
 * an `Actor` and nothing else names a space, so there is no call shape that
 * takes a raw tenant id. Actors are minted at the two places that can prove
 * them — the auth gate (session + membership, slice 3.2) and the job dispatcher
 * (a job payload's space, slice 6.1) — and `packages/db` deliberately exposes
 * no constructor that accepts a tenant id, so this package can never become the
 * third place one is invented.
 */

/** The membership roles `space_member_role` allows, derived from the schema. */
export type SpaceMemberRole = (typeof spaceMemberRole.enumValues)[number];

/** A signed-in operator acting in a space they are a member of. */
export interface UserActor {
  readonly kind: "user";
  readonly spaceId: string;
  readonly userId: string;
  readonly role: SpaceMemberRole;
}

/** A durable job acting in the space its payload names. */
export interface SystemActor {
  readonly kind: "system";
  readonly spaceId: string;
  readonly jobId: string;
}

export type Actor = UserActor | SystemActor;
