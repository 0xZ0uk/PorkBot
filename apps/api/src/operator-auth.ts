import type { TransactionalEmailProvider } from "@porkbot/adapter-kit";
import {
  createEnvironmentCredentialStore,
  createHttpMailProvider,
  MailConfigurationError,
} from "@porkbot/adapters";
import { createActorResolver, createAuth } from "@porkbot/auth";
import type { ResolveActor, SignupGrant } from "@porkbot/auth";
import { bootstrapSignup } from "@porkbot/db";
import type { PostgresDatabase, Queryable } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";

/**
 * The operator auth configuration the API process composes at boot (slices
 * 3.1 and 3.2).
 *
 * `main.ts` is the composition root: it reads the environment, and this module
 * turns that configuration into the three pieces the HTTP surface needs — the
 * Better Auth handler mounted at `/api/auth/*`, the one session resolver the
 * gate calls, and the signup half that gives a new registration its membership.
 * Everything else stays where it already lives: the policy is `createAuth` in
 * `@porkbot/auth`, the membership is `bootstrapSignup` in `@porkbot/db`, and
 * the mail transport is the adapter-kit seam with the HTTP adapter and the
 * offline emulator behind it.
 *
 * The configuration is all-or-nothing. With neither secret nor origin set the
 * process boots fail-closed exactly as before — the route is not mounted and
 * every authenticated procedure answers its typed 401 — and with one of the
 * pair set it refuses to boot rather than guessing the other. There is no
 * environment variable that invents an actor.
 */

/** The pieces the API hands to `createApiApp` when auth is configured. */
export interface OperatorAuth {
  /** Better Auth's request handler, mounted at `/api/auth/*`. */
  readonly handler: (request: Request) => Promise<Response>;
  /** The gate's single session read: a cookie to the membership it acts as. */
  readonly resolveActor: ResolveActor;
}

export interface OperatorAuthOptions {
  /** From `openDatabase`; Better Auth's adapter and the membership read use it. */
  readonly database: PostgresDatabase;
  /** The session and token signing secret. */
  readonly secret: string;
  /** The deployment's public origin: the trusted origin and cookie base. */
  readonly origin: string;
  /** Where reset and verification mail goes; a refusing provider is valid. */
  readonly mail: TransactionalEmailProvider;
  /** Defaults to a JSON logger named for this app. */
  readonly logger?: Logger;
}

/**
 * The scope a grant is persisted in. `bootstrapSignup` opens a transaction and
 * takes an advisory lock, so every statement must travel on one connection:
 * this checks one out of the pool for the duration and releases it after. The
 * grant is what gives a new registration a space and a role; a replay writes
 * nothing (the command is idempotent by user id), which is the repair path
 * `create-auth.ts` points at when the hook fails after the user row exists.
 */
async function bootstrapGrant(database: PostgresDatabase, grant: SignupGrant): Promise<void> {
  const client = await database.$client.connect();

  try {
    const queryableClient: Queryable = {
      async query<Row>(text: string, values?: readonly unknown[]) {
        const result = await client.query(text, values === undefined ? undefined : [...values]);

        return { rows: result.rows as readonly Row[] };
      },
    };

    await bootstrapSignup(queryableClient, { userId: grant.userId, role: grant.role });
  } finally {
    client.release();
  }
}

export function createOperatorAuth(options: OperatorAuthOptions): OperatorAuth {
  const logger = options.logger ?? createLogger({ service: "@porkbot/api" });
  const auth = createAuth({
    database: options.database,
    secret: options.secret,
    baseURL: options.origin,
    trustedOrigins: [options.origin],
    // The cookie posture follows the origin: an https deployment terminates
    // TLS and marks the session cookie secure, a loopback dev origin cannot.
    secureCookies: new URL(options.origin).protocol === "https:",
    mail: options.mail,
    onSignup: (grant) => bootstrapGrant(options.database, grant),
    logger,
  });

  return {
    handler: (request) => auth.handler(request),
    resolveActor: createActorResolver({ auth, database: options.database }),
  };
}

/**
 * The mail transport for a process that was given an endpoint, a sender and a
 * key. All three or none: a partial trio is a configuration the operator must
 * see rather than one the process guesses at. With none, the provider refuses
 * every send with a typed configuration error, so reset and verification mail
 * fails loudly while sign-in and sign-out — which never compose mail — keep
 * working.
 *
 * The key is read here only for its presence; its value is resolved by name
 * through the environment credential store on every send, so the secret is
 * never a constructor argument.
 */
function mailFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  logger: Logger,
): TransactionalEmailProvider {
  const endpoint = blankToUndefined(env["PORKBOT_MAIL_ENDPOINT"]);
  const from = blankToUndefined(env["PORKBOT_MAIL_FROM"]);
  const key = blankToUndefined(env["PORKBOT_MAIL_KEY"]);
  const configured = [endpoint, from, key].filter((value) => value !== undefined).length;

  if (configured === 0) {
    logger.warn(
      "no transactional mail is configured; reset and verification mail will be refused",
      {},
    );

    return {
      async send() {
        throw new MailConfigurationError(
          "endpoint",
          "missing",
          "Set PORKBOT_MAIL_ENDPOINT, PORKBOT_MAIL_FROM and PORKBOT_MAIL_KEY to send mail.",
        );
      },
    };
  }

  if (configured < 3 || endpoint === undefined || from === undefined) {
    throw new Error(
      "PORKBOT_MAIL_ENDPOINT, PORKBOT_MAIL_FROM and PORKBOT_MAIL_KEY must be set together",
    );
  }

  return createHttpMailProvider({
    endpoint,
    from,
    // The key is resolved by name through the environment credential store on
    // every send, so rotation is a variable change and the secret is never a
    // constructor argument.
    credentialName: "PORKBOT_MAIL_KEY",
    credentials: createEnvironmentCredentialStore(env),
  });
}

/**
 * Reads the operator auth configuration from the environment. With the secret
 * and origin both absent, auth is not configured and the caller boots without
 * it (fail-closed); with exactly one, this throws so boot fails by name. The
 * origin is normalized to its origin component, so a trailing slash or a path
 * cannot make the trusted-origin check depend on how an operator typed it.
 */
export function operatorAuthFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly database: PostgresDatabase; readonly logger: Logger },
): OperatorAuth | null {
  const secret = blankToUndefined(env["PORKBOT_AUTH_SECRET"]);
  const rawOrigin = blankToUndefined(env["PORKBOT_AUTH_ORIGIN"]);

  if (secret === undefined && rawOrigin === undefined) {
    options.logger.warn(
      "operator auth is not configured; every authenticated procedure answers 401",
      {},
    );

    return null;
  }

  if (secret === undefined || rawOrigin === undefined) {
    throw new Error("PORKBOT_AUTH_SECRET and PORKBOT_AUTH_ORIGIN must be set together");
  }

  return createOperatorAuth({
    database: options.database,
    secret,
    origin: resolveOrigin(rawOrigin),
    mail: mailFromEnvironment(env, options.logger),
    logger: options.logger,
  });
}

/** An absolute http(s) origin; a path or a relative value is a boot failure. */
function resolveOrigin(raw: string): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PORKBOT_AUTH_ORIGIN must be an absolute URL, got "${raw}"`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`PORKBOT_AUTH_ORIGIN must be an http(s) URL, got "${url.protocol}" instead`);
  }

  return url.origin;
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
