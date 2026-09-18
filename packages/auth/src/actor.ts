import { resolveUserActor } from "@porkbot/db";
import type { PostgresDatabase, UserActor } from "@porkbot/db";
import type { Auth } from "./create-auth.ts";

/**
 * The single auth gate's one job: a request's session to the `Actor` it acts
 * as, or `null` when the request is not signed in.
 *
 * This is the only place in the codebase that reads a session. Better Auth owns
 * the cookie; `getSession` resolves it to a user id; `resolveUserActor` in
 * `@porkbot/db` turns that user id into the membership row that is the
 * authorization root (PRD decision 7). Nothing here names a space: the session
 * reports a user, and the membership decides the scope.
 *
 * The two failure modes are deliberately different. A missing or expired
 * session is `null` — the caller answers `UNAUTHORIZED` and the request was
 * simply anonymous. A session read that *throws* (the auth store is down, the
 * clock is wrong) propagates: the request is not anonymous, it is unanswerable,
 * and turning it into a 401 would disguise an outage as a signed-out client.
 */
export type ResolveActor = (headers: Headers) => Promise<UserActor | null>;

export interface CreateActorResolverOptions {
  /** The configured Better Auth instance; only `getSession` is used. */
  readonly auth: Auth;
  /** The same handle the auth adapter writes sessions through. */
  readonly database: PostgresDatabase;
}

export function createActorResolver(options: CreateActorResolverOptions): ResolveActor {
  return async (headers: Headers): Promise<UserActor | null> => {
    const session = await options.auth.api.getSession({ headers });

    if (session === null) {
      return null;
    }

    return resolveUserActor(options.database, { userId: session.user.id });
  };
}
