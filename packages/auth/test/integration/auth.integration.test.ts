import { MailEmulator } from "@porkbot/adapters";
import { createLogger } from "@porkbot/logging";
import {
  account as accountTable,
  deploymentSettings,
  openDatabase,
  session as sessionTable,
  user as userTable,
  verification as verificationTable,
} from "@porkbot/db";
import type { DatabaseHandle, PostgresDatabase } from "@porkbot/db";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAuth,
  secureSessionCookieName,
  sessionCookieName,
  sessionExpirySeconds,
} from "../../src/index.ts";
import type { Auth, SignupGrant } from "../../src/index.ts";

/**
 * Slice 3.1's acceptance criteria against a real Postgres, through Better
 * Auth's own HTTP handler: these tests exercise the shipped registration gate,
 * session cookies and mail wiring, not a reimplementation of them.
 *
 * The suite covers the criteria directly:
 *
 *   - a fresh deployment (no settings row) refuses every registration and
 *     writes no user, account or session;
 *   - an explicitly open deployment admits the configured admin email as
 *     `owner` and everyone else as `member`, including when the configured
 *     admin email is blank;
 *   - two settings rows that disagree fail the gate closed;
 *   - sessions are cookie-based with the documented attributes and a seven-day
 *     server-side expiry, and a cookie-carrying request from a foreign origin
 *     is refused;
 *   - password reset and verification deliver through the mail provider and
 *     complete their flows.
 */

const baseURL = "http://localhost:3000";
const trustedOrigin = baseURL;
const secret = "integration-secret-not-real-0123456789abcdef";

const adminEmail = "admin@example.invalid";
const strangerEmail = "stranger@example.invalid";
const password = "correct-horse-battery";
const newPassword = "new-correct-horse-battery";

let suite: SuiteDatabase | undefined;
let handle: DatabaseHandle | undefined;
let instance: Auth | undefined;

const grants: SignupGrant[] = [];

// The offline emulator from @porkbot/adapters (the package's one test-only
// import): the auth flows deliver into a mailbox this suite reads, with no key
// and no network, which is the adapter's acceptance criterion exercised in place.
const mail = new MailEmulator();

function database(): PostgresDatabase {
  if (handle === undefined) {
    throw new Error("the suite database was not opened; the beforeAll hook failed first");
  }

  return handle.database;
}

function auth(): Auth {
  if (instance === undefined) {
    throw new Error("the auth instance was not created; the beforeAll hook failed first");
  }

  return instance;
}

function buildAuth(options: { readonly secureCookies?: boolean } = {}): Auth {
  return createAuth({
    database: database(),
    secret,
    baseURL,
    trustedOrigins: [trustedOrigin],
    secureCookies: options.secureCookies ?? false,
    mail,
    onSignup: (grant) => {
      grants.push(grant);
    },
    // The library logs hook failures; the suite asserts responses, not logs,
    // so the sink is intentionally silent. The level is `info` on purpose: at
    // `error`/`warn`/`debug` the library mirrors API errors to its own console
    // logger, which would make the tier's output depend on a library default.
    logger: createLogger({ level: "info", write: () => {} }),
  });
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "auth_email_password" });
  handle = openDatabase(suite.connectionString);
  instance = buildAuth();
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await suite?.destroy();
});

beforeEach(async () => {
  grants.length = 0;
  mail.clear();

  // Deleting a user cascades to its sessions and accounts; verification rows
  // and the settings row stand alone.
  await database().delete(userTable);
  await database().delete(verificationTable);
  await database().delete(deploymentSettings);
});

interface RequestOptions {
  readonly body?: unknown;
  /** `null` sends no Origin header, as a non-browser client would. */
  readonly origin?: string | null;
  readonly cookie?: string;
}

function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers();
  const origin = options.origin === undefined ? trustedOrigin : options.origin;

  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return auth().handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
}

function get(path: string, params: Readonly<Record<string, string>>): Promise<Response> {
  const url = new URL(`${baseURL}/api/auth${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return auth().handler(new Request(url, { method: "GET", headers: { origin: trustedOrigin } }));
}

function signUp(email: string, options: RequestOptions = {}): Promise<Response> {
  return request("/sign-up/email", {
    ...options,
    body: { name: "Test Operator", email, password },
  });
}

function signIn(
  email: string,
  signInPassword: string,
  options: RequestOptions = {},
): Promise<Response> {
  return request("/sign-in/email", {
    ...options,
    body: { email, password: signInPassword },
  });
}

async function configure(options: {
  readonly signupsEnabled: boolean;
  readonly adminEmail?: string | null;
}): Promise<void> {
  await database()
    .insert(deploymentSettings)
    .values({
      signupsEnabled: options.signupsEnabled,
      adminEmail: options.adminEmail ?? null,
    });
}

function sessionCookie(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find(
      (cookie) =>
        cookie.startsWith(`${sessionCookieName}=`) ||
        cookie.startsWith(`${secureSessionCookieName}=`),
    );
}

/** The attribute segments of one Set-Cookie value, without name and value. */
function cookieAttributes(cookie: string): readonly string[] {
  return cookie
    .split(";")
    .slice(1)
    .map((attribute) => attribute.trim());
}

async function countUsers(): Promise<number> {
  const rows = await database().select().from(userTable);

  return rows.length;
}

async function body(code: Response): Promise<Record<string, unknown>> {
  return (await code.json()) as Record<string, unknown>;
}

describe("a fresh deployment", () => {
  it("refuses a stranger and writes no user, account or session", async () => {
    const response = await signUp(strangerEmail);
    const payload = await body(response);

    expect(response.status).toBe(403);
    expect(payload["code"]).toBe("signups_closed");
    expect(grants).toEqual([]);
    expect(await countUsers()).toBe(0);

    const accounts = await database().select().from(accountTable);
    const sessions = await database().select().from(sessionTable);

    expect(accounts).toEqual([]);
    expect(sessions).toEqual([]);
  });

  it("refuses the configured admin email while a settings row says signups are closed", async () => {
    await configure({ signupsEnabled: false, adminEmail });

    const response = await signUp(adminEmail);

    expect(response.status).toBe(403);
    expect((await body(response))["code"]).toBe("signups_closed");
    expect(grants).toEqual([]);
    expect(await countUsers()).toBe(0);
  });

  it("fails closed when the settings rows disagree with each other", async () => {
    await database().insert(deploymentSettings).values({ signupsEnabled: true, adminEmail });
    await database().insert(deploymentSettings).values({ signupsEnabled: false });

    const response = await signUp(adminEmail);

    // The reader throws on the conflict and the library's gate turns a thrown
    // hook into a refusal, so the client sees the generic validation refusal
    // and never a 200 that guessed which row won.
    expect(response.status).toBe(403);
    expect((await body(response))["code"]).toBe("validation_failed");
    expect(await countUsers()).toBe(0);
  });
});

describe("an explicitly open deployment", () => {
  it("grants owner to the configured admin email and nobody else", async () => {
    await configure({ signupsEnabled: true, adminEmail: `  ${adminEmail.toUpperCase()}  ` });

    const owner = await signUp(adminEmail);
    const member = await signUp(strangerEmail);

    expect(owner.status).toBe(200);
    expect(member.status).toBe(200);
    expect(grants.map((grant) => grant.role)).toEqual(["owner", "member"]);
    expect(grants.map((grant) => grant.email)).toEqual([adminEmail, strangerEmail]);
  });

  it("never inherits ownership from a blank admin email", async () => {
    await configure({ signupsEnabled: true, adminEmail: "   " });

    const response = await signUp(strangerEmail);

    expect(response.status).toBe(200);
    expect(grants).toEqual([expect.objectContaining({ email: strangerEmail, role: "member" })]);
  });

  it("cannot register the same admin email twice, so no second owner exists", async () => {
    await configure({ signupsEnabled: true, adminEmail });

    await signUp(adminEmail);
    const second = await signUp(adminEmail);

    // 422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`: the unique index on the user
    // row, not the signup gate, refuses the second attempt.
    expect(second.status).toBe(422);
    expect(grants.map((grant) => grant.role)).toEqual(["owner"]);
    expect(await countUsers()).toBe(1);
  });
});

describe("sessions", () => {
  it("sets a cookie with the documented posture and a seven-day server-side expiry", async () => {
    await configure({ signupsEnabled: true, adminEmail });

    const response = await signUp(adminEmail);
    const cookie = sessionCookie(response);

    expect(response.status).toBe(200);
    expect(cookie).toBeDefined();

    const attributes = cookieAttributes(cookie ?? "");

    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Lax");
    expect(attributes).toContain("Path=/");
    expect(attributes).not.toContain("Secure");

    const sessions = await database().select().from(sessionTable);

    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session).toBeDefined();

    if (session !== undefined) {
      const lifetimeSeconds = (session.expiresAt.getTime() - session.createdAt.getTime()) / 1000;

      expect(lifetimeSeconds).toBeGreaterThan(sessionExpirySeconds - 60);
      expect(lifetimeSeconds).toBeLessThanOrEqual(sessionExpirySeconds);
    }
  });

  it("authenticates with the cookie and returns nothing without it", async () => {
    await configure({ signupsEnabled: true, adminEmail });

    const response = await signUp(adminEmail);
    const cookie = sessionCookie(response);

    expect(cookie).toBeDefined();

    const authenticated = await auth().api.getSession({
      headers: new Headers({ cookie: cookie ?? "" }),
    });

    expect(authenticated?.user.email).toBe(adminEmail);

    const anonymous = await auth().api.getSession({ headers: new Headers() });

    expect(anonymous).toBeNull();
  });

  it("marks the cookie Secure when the deployment terminates TLS", async () => {
    await configure({ signupsEnabled: true, adminEmail });

    const tlsInstance = buildAuth({ secureCookies: true });
    const response = await tlsInstance.handler(
      new Request(`${baseURL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: trustedOrigin,
        },
        body: JSON.stringify({ name: "Test Operator", email: adminEmail, password }),
      }),
    );

    const cookie = sessionCookie(response);

    expect(response.status).toBe(200);
    expect(cookie).toBeDefined();
    expect(cookieAttributes(cookie ?? "")).toContain("Secure");
  });

  it("refuses a foreign-origin registration even before a cookie exists", async () => {
    await configure({ signupsEnabled: true, adminEmail });

    const response = await signUp(strangerEmail, { origin: "https://evil.example" });

    expect(response.status).toBe(403);
    expect(await countUsers()).toBe(0);
  });

  it("refuses a foreign-origin request that carries the session cookie", async () => {
    await configure({ signupsEnabled: true, adminEmail });

    const response = await signUp(adminEmail);
    const cookie = sessionCookie(response)?.split(";")[0];
    expect(cookie).toBeDefined();

    const foreign = await request("/sign-out", {
      origin: "https://evil.example",
      cookie: cookie ?? "",
    });

    expect(foreign.status).toBe(403);

    // The refused request neither signed the operator out nor leaked a new
    // session: the cookie still authenticates.
    const stillSignedIn = await auth().api.getSession({
      headers: new Headers({ cookie: cookie ?? "" }),
    });

    expect(stillSignedIn?.user.email).toBe(adminEmail);

    const trusted = await request("/sign-out", { cookie: cookie ?? "" });

    expect(trusted.status).toBe(200);
  });
});

describe("mail flows", () => {
  it("delivers the reset link through the provider and lets the password change", async () => {
    await configure({ signupsEnabled: true, adminEmail });
    await signUp(adminEmail);

    const resetRequest = await request("/request-password-reset", {
      body: { email: adminEmail, redirectTo: baseURL },
    });

    expect(resetRequest.status).toBe(200);

    const message = mail.lastMessage();

    expect(message?.to).toBe(adminEmail);
    expect(message?.subject).toBe("Reset your PorkBot password");

    const token = /\/reset-password\/([^?\s]+)\?/.exec(message?.text ?? "")?.[1];
    expect(token).toBeDefined();

    const reset = await request("/reset-password", {
      body: { newPassword, token },
    });

    expect(reset.status).toBe(200);

    const withNewPassword = await signIn(adminEmail, newPassword);

    expect(withNewPassword.status).toBe(200);

    const withOldPassword = await signIn(adminEmail, password);

    expect(withOldPassword.status).toBe(401);
  });

  it("delivers the verification link through the provider and marks the address verified", async () => {
    await configure({ signupsEnabled: true, adminEmail });
    await signUp(adminEmail);

    const verificationRequest = await request("/send-verification-email", {
      body: { email: adminEmail, callbackURL: baseURL },
    });

    expect(verificationRequest.status).toBe(200);

    const message = mail.lastMessage();

    expect(message?.to).toBe(adminEmail);
    expect(message?.subject).toBe("Verify your PorkBot email");

    const token = /[?&]token=([^&\s]+)/.exec(message?.text ?? "")?.[1];
    expect(token).toBeDefined();

    const verified = await get("/verify-email", { token: decodeURIComponent(token ?? "") });

    expect(verified.status).toBe(200);

    const users = await database().select().from(userTable);

    expect(users[0]?.emailVerified).toBe(true);
  });
});
