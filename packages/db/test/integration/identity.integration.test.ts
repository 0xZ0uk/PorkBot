import { randomUUID } from "node:crypto";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The identity and tenancy constraints against a real Postgres — the half of
 * slice 2.2's acceptance criteria a metadata test cannot prove. Every insert
 * below goes through raw SQL, not the ORM, so what rejects the row is the
 * database:
 *
 *   - the membership role enum rejects a value outside its closed set (the
 *     runs-domain statuses get the same treatment in slice 2.3);
 *   - the (space, user) uniqueness is enforced, not hoped for;
 *   - the email, session-token and provider-account dedupe indexes reject a
 *     duplicate and cannot be bypassed with a NULL;
 *   - deployment settings cannot be open to signups without an explicit
 *     `signups_enabled` value and a configured admin email.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_identity" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

async function insertUser(email?: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    ["Test Operator", email ?? `${randomUUID()}@example.invalid`],
  );
  const id = rows[0]?.id;

  if (id === undefined) {
    throw new Error("the user insert returned no id");
  }

  return id;
}

async function insertSpace(): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into space (name) values ($1) returning id::text as id",
    ["Home"],
  );
  const id = rows[0]?.id;

  if (id === undefined) {
    throw new Error("the space insert returned no id");
  }

  return id;
}

/**
 * Runs a statement that must fail and returns the Postgres error. Failing here
 * when the statement succeeds keeps every test's intent legible: the assertion
 * is that the database says no.
 */
async function rejection(
  sql: string,
  values: unknown[],
): Promise<{ code?: string; message: string }> {
  try {
    await db().query(sql, values);
  } catch (error) {
    const failure = error as { code?: string; message: string };

    return {
      ...(failure.code === undefined ? {} : { code: failure.code }),
      message: failure.message,
    };
  }

  throw new Error(`the database accepted a statement it should have rejected: ${sql}`);
}

describe("space membership", () => {
  it("rejects a role outside the enum, and accepts the closed values", async () => {
    const spaceId = await insertSpace();
    const userId = await insertUser();

    const failed = await rejection(
      "insert into space_member (space_id, user_id, role) values ($1, $2, $3)",
      [spaceId, userId, "superuser"],
    );

    expect(failed.code).toBe("22P02");
    expect(failed.message).toContain("invalid input value for enum space_member_role");

    await db().query(
      "insert into space_member (space_id, user_id, role) values ($1, $2, 'owner')",
      [spaceId, userId],
    );

    const { rows } = await db().query<{ role: string }>(
      "select role::text as role from space_member where space_id = $1 and user_id = $2",
      [spaceId, userId],
    );

    expect(rows[0]?.role).toBe("owner");
  });

  it("defaults a membership to member, so privilege is never the default", async () => {
    const spaceId = await insertSpace();
    const userId = await insertUser();

    await db().query("insert into space_member (space_id, user_id) values ($1, $2)", [
      spaceId,
      userId,
    ]);

    const { rows } = await db().query<{ role: string }>(
      "select role::text as role from space_member where space_id = $1 and user_id = $2",
      [spaceId, userId],
    );

    expect(rows[0]?.role).toBe("member");
  });

  it("enforces one membership per (space, user) at the database", async () => {
    const spaceId = await insertSpace();
    const userId = await insertUser();

    await db().query("insert into space_member (space_id, user_id) values ($1, $2)", [
      spaceId,
      userId,
    ]);

    const failed = await rejection("insert into space_member (space_id, user_id) values ($1, $2)", [
      spaceId,
      userId,
    ]);

    expect(failed.code).toBe("23505");
    expect(failed.message).toContain("space_member_space_user_unique");
  });

  it("rejects a membership with no space or no user, not a NULL-keyed duplicate", async () => {
    const spaceId = await insertSpace();

    const withoutSpace = await rejection(
      "insert into space_member (space_id, user_id) values ($1, $2)",
      [null, await insertUser()],
    );
    const withoutUser = await rejection(
      "insert into space_member (space_id, user_id) values ($1, $2)",
      [spaceId, null],
    );

    expect(withoutSpace.code).toBe("23502");
    expect(withoutUser.code).toBe("23502");
  });
});

describe("auth and credential dedupe", () => {
  it("rejects a duplicate and a NULL email, so the unique index stays in force", async () => {
    const email = `${randomUUID()}@example.invalid`;

    await insertUser(email);

    const duplicate = await rejection('insert into "user" (name, email) values ($1, $2)', [
      "Second Operator",
      email,
    ]);
    const missing = await rejection('insert into "user" (name, email) values ($1, $2)', [
      "No Address",
      null,
    ]);

    expect(duplicate.code).toBe("23505");
    expect(duplicate.message).toContain("user_email_unique");
    expect(missing.code).toBe("23502");
    expect(missing.message).toContain('column "email"');
  });

  it("rejects a duplicate and a NULL session token", async () => {
    const token = randomUUID();
    const first = await insertUser();
    const second = await insertUser();

    await db().query(
      "insert into session (user_id, token, expires_at) values ($1, $2, now() + interval '1 day')",
      [first, token],
    );

    const duplicate = await rejection(
      "insert into session (user_id, token, expires_at) values ($1, $2, now() + interval '1 day')",
      [second, token],
    );
    const missing = await rejection(
      "insert into session (user_id, token, expires_at) values ($1, $2, now() + interval '1 day')",
      [second, null],
    );

    expect(duplicate.code).toBe("23505");
    expect(duplicate.message).toContain("session_token_unique");
    expect(missing.code).toBe("23502");
    expect(missing.message).toContain('column "token"');
  });

  it("rejects the same provider account linked twice, and the same account with a NULL id", async () => {
    const userId = await insertUser();

    await db().query(
      "insert into account (user_id, account_id, provider_id) values ($1, $2, 'credential')",
      [userId, userId],
    );

    const duplicate = await rejection(
      "insert into account (user_id, account_id, provider_id) values ($1, $2, 'credential')",
      [await insertUser(), userId],
    );
    const missing = await rejection(
      "insert into account (user_id, account_id, provider_id) values ($1, $2, 'credential')",
      [userId, null],
    );

    expect(duplicate.code).toBe("23505");
    expect(duplicate.message).toContain("account_provider_account_unique");
    expect(missing.code).toBe("23502");
    expect(missing.message).toContain('column "account_id"');
  });
});

describe("deployment settings", () => {
  it("refuses to open signups without a configured admin email", async () => {
    const failed = await rejection(
      "insert into deployment_settings (signups_enabled) values (true)",
      [],
    );

    expect(failed.code).toBe("23514");
    expect(failed.message).toContain("deployment_settings_signups_require_admin");
  });

  it("refuses a settings row that does not state what signups are", async () => {
    const failed = await rejection("insert into deployment_settings (admin_email) values ($1)", [
      "admin@example.invalid",
    ]);

    expect(failed.code).toBe("23502");
    expect(failed.message).toContain('column "signups_enabled"');
  });

  it("accepts an explicit configuration: open with an admin, closed without one", async () => {
    await db().query(
      "insert into deployment_settings (signups_enabled, admin_email) values (true, $1)",
      ["admin@example.invalid"],
    );
    await db().query("insert into deployment_settings (signups_enabled) values (false)");

    const { rows } = await db().query<{ open: string; closed: string }>(
      "select count(*) filter (where signups_enabled)::text as open, " +
        "count(*) filter (where not signups_enabled)::text as closed from deployment_settings",
    );

    expect(rows[0]?.open).toBe("1");
    expect(rows[0]?.closed).toBe("1");
  });
});
