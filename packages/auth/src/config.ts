/**
 * The session and cookie posture, in one place.
 *
 * Sessions are cookie-based: Better Auth mints an opaque token, stores the
 * session row in Postgres, and sets one `HttpOnly` cookie that the browser
 * cannot read from script. The posture below is the reviewable claim — every
 * value is passed to Better Auth by `createAuth`, and the integration suite
 * asserts the resulting cookie and session row rather than trusting the config.
 *
 * CSRF is handled by the library's origin and Fetch Metadata checks, which
 * `createAuth` pins on (`advanced.disableCSRFCheck: false` and
 * `advanced.disableOriginCheck: false`) rather than leaving to library defaults.
 * `SameSite=Lax` is the second layer: a cross-site form POST does not carry the
 * cookie, and a top-level navigation that would is rejected by the origin check
 * unless its origin is in the deployment's explicit `trustedOrigins`. There is
 * no token-in-body scheme for a browser client to forget; the cookie itself is
 * the credential and the origin check is what makes it unusable from another
 * site.
 */

/** Sessions expire after 7 days, matching the library's documented default. */
export const sessionExpirySeconds = 60 * 60 * 24 * 7;

/** An active session's row is refreshed at most once a day, not per request. */
export const sessionRefreshAfterSeconds = 60 * 60 * 24;

/** How long a session counts as "fresh" for sensitive operations (1 day). */
export const sessionFreshForSeconds = 60 * 60 * 24;

/** Prefix for every auth cookie; the session cookie is `porkbot.session_token`. */
export const cookiePrefix = "porkbot";

export const sessionCookieName = `${cookiePrefix}.session_token`;

/**
 * RFC 6265bis' secure-cookie prefix. A browser refuses a cookie that carries it
 * without `Secure`, which is what pins the credential to TLS; a deployment with
 * `secureCookies: false` (local HTTP) uses the unprefixed name.
 */
export const secureCookiePrefix = "__Secure-";

export const secureSessionCookieName = `${secureCookiePrefix}${sessionCookieName}`;

/**
 * The attributes every auth cookie carries. `HttpOnly` keeps the credential
 * out of JavaScript, `Lax` keeps it off cross-site requests, and `/` keeps one
 * cookie covering the whole origin (PRD decision 32: web, API and streaming
 * share one origin). `Secure` is deliberately not here: it is decided by
 * `secureCookies`, because a local HTTP deployment would otherwise be unable
 * to sign in, and the API slice pins it to true wherever TLS terminates.
 */
export const sessionCookieAttributes = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} as const;

/** Password reset links are single-use and expire after one hour. */
export const passwordResetTokenExpirySeconds = 60 * 60;

/** Verification links expire after one hour. */
export const emailVerificationTokenExpirySeconds = 60 * 60;
