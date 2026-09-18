import { decideSignup } from "@porkbot/core";
import type { SignupDecision, SignupRole } from "@porkbot/core";
import { account, readDeploymentSettings, session, user, verification } from "@porkbot/db";
import type { PostgresDatabase } from "@porkbot/db";
import type { TransactionalEmailProvider } from "@porkbot/adapter-kit";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  cookiePrefix,
  emailVerificationTokenExpirySeconds,
  passwordResetTokenExpirySeconds,
  sessionCookieAttributes,
  sessionExpirySeconds,
  sessionFreshForSeconds,
  sessionRefreshAfterSeconds,
} from "./config.ts";
import { authLogger } from "./logging.ts";
import { passwordResetEmail, verificationEmail } from "./mail.ts";

/**
 * The Better Auth instance, wired fail-closed (PRD decision 8).
 *
 * Three things happen here and nowhere else:
 *
 *   1. `user.validateUserInfo` is the registration gate. Before a `user` row is
 *      written, it reads the deployment settings and asks `decideSignup` in
 *      `@porkbot/core`. No settings row, `signups_enabled` false, or a row the
 *      settings reader refuses to resolve all end in a 403 with no user, no
 *      account and no session; only an explicit `true` opens the door, and only
 *      the configured admin email comes out as `owner`. The library fails this
 *      hook closed too: if the settings read throws, it rejects the signup
 *      rather than admitting it.
 *
 *   2. `databaseHooks.user.create.after` hands the admitted registration to
 *      `onSignup` together with the decided role. This is where ownership
 *      leaves the auth layer: slice 3.4's bootstrap owns the space and the
 *      membership row, so the auth package reports the grant instead of
 *      inventing a tenant. The role is recomputed at that point and defaults to
 *      `member` if the deployment stopped being open in between — a
 *      misconfiguration can lose someone ownership, never grant it.
 *
 *   3. `emailAndPassword.sendResetPassword` and
 *      `emailVerification.sendVerificationEmail` build a message and hand it to
 *      the injected `TransactionalEmailProvider`. There is no SMTP client, no
 *      provider name and no transport configuration in this package; slice 3.5
 *      owns the implementations. Verification is not required to sign in
 *      (`requireEmailVerification` stays off), so a deployment whose mail is
 *      not configured yet still has working sign-in and sign-out; reset and
 *      verify mail is composed and awaited, and a provider that cannot send
 *      rejects the send rather than delivering nothing quietly.
 *
 * Sessions are cookie-based with the posture documented in `config.ts`:
 * these options are the config half, and `test/integration/auth.integration`
 * asserts the cookie and session half.
 */

/** What the auth layer decided about an admitted registration. */
export interface SignupGrant {
  readonly userId: string;
  readonly email: string;
  readonly role: SignupRole;
}

export interface CreateAuthOptions {
  /** From `openDatabase`; the auth package never opens or names a driver. */
  readonly database: PostgresDatabase;
  /** Token and cookie signing secret. Required: no derived default ships. */
  readonly secret: string;
  /** The deployment's public origin, used to build reset and verify links. */
  readonly baseURL: string;
  /**
   * Origins allowed to make cookie-authenticated state-changing requests. The
   * library's origin and Fetch Metadata checks stay on, so this list is the
   * whole cross-site surface and an empty one admits nothing browser-made.
   */
  readonly trustedOrigins: readonly string[];
  /** `Secure` on auth cookies; true wherever TLS terminates (PRD decision 32). */
  readonly secureCookies: boolean;
  /** Where reset and verification mail goes (slice 3.5 implementations). */
  readonly mail: TransactionalEmailProvider;
  /**
   * Persists the grant — slice 3.4 creates the space and the membership row.
   * A rejection here fails the signup response after the user row exists; the
   * bootstrap path is the repair, which is why the decision is reported rather
   * than silently assumed.
   */
  readonly onSignup: (grant: SignupGrant) => Promise<void> | void;
  /** Defaults to a JSON logger named for this package. */
  readonly logger?: Logger;
}

/**
 * The instance type. Derived from the factory rather than annotated with the
 * library's generic `Auth`, because the configured options narrow the context
 * type and the generic form is not assignable back to it.
 */
export type Auth = ReturnType<typeof createAuth>;

function refusalDescription(reason: "signups_closed" | "invalid_email"): string {
  return reason === "signups_closed"
    ? "Signups are closed on this deployment."
    : "A valid email address is required.";
}

/**
 * One reading of the settings for one attempt. The gate and the grant each call
 * it, so the grant reflects the second read: `owner` only when that read is
 * open *and* the address is the configured admin email.
 */
async function decideRegistration(
  database: PostgresDatabase,
  email: string,
): Promise<SignupDecision> {
  const settings = await readDeploymentSettings(database);

  return decideSignup(email, settings);
}

export function createAuth(options: CreateAuthOptions) {
  const logger = options.logger ?? createLogger({ service: "@porkbot/auth" });

  return betterAuth({
    appName: "PorkBot",
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [...options.trustedOrigins],
    logger: authLogger(logger),
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    advanced: {
      // Postgres 18's `uuidv7()` supplies every id (slice 2.2); the library
      // must not invent its own.
      database: { generateId: false },
      cookiePrefix,
      useSecureCookies: options.secureCookies,
      defaultCookieAttributes: { ...sessionCookieAttributes },
      // Both are false by default in production, but the library skips origin
      // checks when NODE_ENV is `test`. Writing the decision down keeps the
      // posture the same in every environment, so the CSRF assertion in the
      // integration suite tests the shipped behaviour instead of a bypass.
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    emailAndPassword: {
      enabled: true,
      // Sign-in stays available when mail is not configured; reset and verify
      // still compose a message and await the provider, so a provider failure
      // is a logged send failure rather than a silently skipped one.
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: passwordResetTokenExpirySeconds,
      sendResetPassword: async ({ user: recipient, url }) => {
        await options.mail.send(passwordResetEmail(recipient.email, url));
      },
    },
    emailVerification: {
      expiresIn: emailVerificationTokenExpirySeconds,
      // Signup never depends on mail being configured; verifying is explicit.
      sendOnSignUp: false,
      sendVerificationEmail: async ({ user: recipient, url }) => {
        await options.mail.send(verificationEmail(recipient.email, url));
      },
    },
    session: {
      expiresIn: sessionExpirySeconds,
      updateAge: sessionRefreshAfterSeconds,
      freshAge: sessionFreshForSeconds,
    },
    user: {
      validateUserInfo: async ({ user: candidate, source }) => {
        if (source.action !== "create-user") {
          return;
        }

        const email = typeof candidate.email === "string" ? candidate.email : "";
        const decision = await decideRegistration(options.database, email);

        if (decision.ok) {
          return;
        }

        return {
          error: decision.reason,
          errorDescription: refusalDescription(decision.reason),
        };
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (created) => {
            const email = typeof created.email === "string" ? created.email : "";
            let role: SignupRole = "member";

            try {
              const decision = await decideRegistration(options.database, email);
              role = decision.ok ? decision.role : "member";
            } catch (error) {
              // The gate already admitted this registration; a failure between
              // the two reads must not leave the new user with no grant at
              // all. Member is the least privilege, and slice 3.4's bootstrap
              // reconciles ownership.
              logger.error("signup grant could not re-read the deployment settings", {
                error,
              });
            }

            await options.onSignup({ userId: created.id, email, role });
          },
        },
      },
    },
  });
}
