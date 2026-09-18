export const moduleInfo = {
  name: "@porkbot/auth",
  summary: "The single authentication gate, actor resolution and owner policy.",
} as const;

// The one auth instance factory: Better Auth's email/password and session
// engine wired to the deployment settings, the fail-closed signup policy in
// `@porkbot/core`, and the mail seam from `@porkbot/adapter-kit`. Consumers get
// a configured instance, not the library: importing `better-auth` directly is
// restricted to this package by the module map.
export { createAuth } from "./create-auth.ts";
export type { Auth, CreateAuthOptions, SignupGrant } from "./create-auth.ts";

// The gate itself: a request's session to the `Actor` it acts as (slice 3.2).
// The API composes this behind its single session read; the name and the
// failure modes are the contract between this package and the transport.
export { createActorResolver } from "./actor.ts";
export type { CreateActorResolverOptions, ResolveActor } from "./actor.ts";

// The session posture as values, so the API and the web client can name the
// cookie they hand around and a test can assert the expiry the deployment
// documents instead of restating it.
export {
  secureSessionCookieName,
  sessionCookieAttributes,
  sessionCookieName,
  sessionExpirySeconds,
  sessionFreshForSeconds,
  sessionRefreshAfterSeconds,
} from "./config.ts";
