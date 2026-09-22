import { InProcessRealtimeFanout, MailEmulator } from "@porkbot/adapters";
import { sessionCookieName } from "@porkbot/auth";
import {
  createRepositories,
  deploymentSettings,
  openDatabase,
  queryable,
  readDeploymentSettings,
  space as spaceTable,
  spaceMember as spaceMemberTable,
  user as userTable,
} from "@porkbot/db";
import type { DatabaseHandle, PostgresDatabase } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "../../src/app.ts";
import { createOperatorAuth } from "../../src/operator-auth.ts";
import type { OperatorAuth } from "../../src/operator-auth.ts";
import { createDeploymentService } from "../../src/services/deployment.ts";

/**
 * The operator auth wiring end to end, against a real Postgres: the shipped
 * `createOperatorAuth` composition (Better Auth's handler, the signup gate and
 * its membership bootstrap, the session resolver) mounted in the shipped HTTP
 * app, driven the way a browser drives it — sign-up over `/api/auth/*`, then
 * an authenticated contract call over `/rpc` carrying the session cookie.
 *
 * What the unit suites cannot see is the seam this file exists for: that the
 * cookie Better Auth mints resolves, through `resolveUserActor`, to the
 * membership `bootstrapSignup` wrote, and that the actor-scoped repositories
 * are built from it. No fake is injected between those halves.
 */

const adminEmail = "owner@example.invalid";
const password = "correct-horse-battery";
const origin = "http://localhost:5173";
const secret = "integration-secret-not-real-0123456789abcdef";

let suite: SuiteDatabase | undefined;
let handle: DatabaseHandle | undefined;
let operator: OperatorAuth | undefined;
let app: ReturnType<typeof createApiApp> | undefined;

// Silent at `info`: the library mirrors API errors to its own console logger at
// debug/warn/error, and this suite asserts responses, not log output.
const logger = createLogger({ level: "info", service: "@porkbot/api", write: () => {} });

function database(): PostgresDatabase {
  if (handle === undefined) {
    throw new Error("the suite database was not opened; the beforeAll hook failed first");
  }

  return handle.database;
}

function api(): ReturnType<typeof createApiApp> {
  if (app === undefined) {
    throw new Error("the app was not composed; the beforeAll hook failed first");
  }

  return app;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "api_operator_auth" });

  const opened = openDatabase(suite.connectionString, "api");

  handle = opened;
  operator = createOperatorAuth({
    database: opened.database,
    secret,
    origin,
    mail: new MailEmulator(),
    logger,
  });
  app = createApiApp({
    services: {
      deployment: createDeploymentService(() => readDeploymentSettings(opened.database)),
      realtime: new InProcessRealtimeFanout(),
    },
    logger,
    authHandler: operator.handler,
    resolveActor: operator.resolveActor,
    repositoriesFor: (actor) => createRepositories(actor, queryable(opened), {}),
  });
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await suite?.destroy();
});

beforeEach(async () => {
  await database().delete(spaceTable);
  await database().delete(userTable);
  await database().delete(deploymentSettings);
});

async function configure(): Promise<void> {
  await database().insert(deploymentSettings).values({ signupsEnabled: true, adminEmail });
}

async function signUp(email: string): Promise<Response> {
  return api().request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Local Operator", email, password }),
  });
}

async function signOut(cookie: string): Promise<Response> {
  return api().request("/api/auth/sign-out", {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

/** The `name=value` segment of the session cookie a sign-in/up response set. */
function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${sessionCookieName}=`));

  if (cookie === undefined) {
    throw new Error("the response set no session cookie");
  }

  const [pair] = cookie.split(";");

  if (pair === undefined) {
    throw new Error("the session cookie was malformed");
  }

  return pair;
}

/** One contract call in the RPC wire format, carrying a session cookie. */
async function rpc(
  path: string,
  options: { readonly cookie?: string; readonly body?: string } = {},
): Promise<Response> {
  return api().request(`/rpc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    body: options.body ?? "{}",
  });
}

describe("a deployment with no settings row", () => {
  it("refuses the registration and writes no user", async () => {
    const response = await signUp(adminEmail);

    expect(response.status).toBe(403);
    expect(await database().select().from(userTable)).toEqual([]);
  });
});

describe("an open deployment", () => {
  it("admits the configured admin, writes the owner membership and resolves the actor", async () => {
    await configure();

    const registered = await signUp(adminEmail);

    expect(registered.status).toBe(200);

    const cookie = sessionCookie(registered);
    const membership = await database().select().from(spaceMemberTable);

    expect(membership).toHaveLength(1);
    expect(membership[0]?.role).toBe("owner");

    const me = await rpc("account/me", { cookie });

    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      json: {
        userId: expect.any(String),
        spaceId: membership[0]?.spaceId,
        role: "owner",
      },
    });

    // The actor-scoped repositories are built from the same resolver, so a
    // scoped read reaches the database under the membership's space.
    const bots = await rpc("bots/list", {
      cookie,
      body: JSON.stringify({ json: { scope: "active" } }),
    });

    expect(bots.status).toBe(200);
    expect(await bots.json()).toMatchObject({ json: { bots: [] } });
  });

  it("answers an anonymous call with the typed 401", async () => {
    await configure();

    const response = await rpc("account/me");

    expect(response.status).toBe(401);
  });

  it("stops resolving an actor after sign-out", async () => {
    await configure();

    const registered = await signUp(adminEmail);
    const cookie = sessionCookie(registered);

    expect((await rpc("account/me", { cookie })).status).toBe(200);
    expect((await signOut(cookie)).status).toBe(200);

    // Better Auth invalidates the server-side session; the stale cookie is
    // anonymous rather than a live actor.
    expect((await rpc("account/me", { cookie })).status).toBe(401);
  });
});
