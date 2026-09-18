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
 * takes a raw tenant id. The auth gate resolves actors from a session plus a
 * membership (slice 3.2) and the job dispatcher from a job payload's space
 * (slice 6.1); the one actor this package resolves itself is
 * `bootstrapSignup`'s, for the user whose membership it just wrote, from the
 * user id the auth layer reported — and it too never accepts a space id, so
 * `packages/db` still has no constructor that invents a tenant.
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
