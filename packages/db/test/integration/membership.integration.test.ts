import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/database.ts";
import type { DatabaseHandle } from "../../src/database.ts";
import { resolveUserActor } from "../../src/membership.ts";

/**
 * The membership read where the SQL runs: a real Postgres, the same major the
 * deployment uses. The unit suite proves the statement shape; this suite
 * answers what only a server can — a real membership resolves to its actor, a
 * user with none resolves to `null`, a revoked membership stops resolving, and
 * a user with more than one membership resolves the same one every time.
 */

let suite: SuiteDatabase | undefined;
let handle: DatabaseHandle | undefined;
let client: Client | undefined;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_membership" });
  handle = openDatabase(suite.connectionString, "api");
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await handle?.close();
  await suite?.destroy();
});

beforeEach(async () => {
  // Memberships cascade from the user; spaces stand alone.
  await query('delete from "user"');
  await query("delete from space");
});

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

function database() {
  if (handle === undefined) {
    throw new Error("the suite database was not opened; the beforeAll hook failed first");
  }

  return handle.database;
}

async function query<Row>(text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
  const { rows } = await db().query(text, [...values]);

  return rows as readonly Row[];
}

async function insertUser(): Promise<string> {
  const rows = await query<{ readonly id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    ["Test Operator", `${randomUUID()}@example.invalid`],
  );

  return rows[0]?.id ?? "";
}

async function insertSpace(name: string): Promise<string> {
  const rows = await query<{ readonly id: string }>(
    "insert into space (name) values ($1) returning id::text as id",
    [name],
  );

  return rows[0]?.id ?? "";
}

async function insertMembership(
  spaceId: string,
  userId: string,
  role: "owner" | "member",
  createdAt?: string,
): Promise<void> {
  await query(
    "insert into space_member (space_id, user_id, role, created_at) " +
      "values ($1, $2, $3, coalesce($4::timestamptz, now()))",
    [spaceId, userId, role, createdAt ?? null],
  );
}

describe("resolving a session's actor", () => {
  it("returns the membership's space and role", async () => {
    const userId = await insertUser();
    const spaceId = await insertSpace("My space");
    await insertMembership(spaceId, userId, "owner");

    await expect(resolveUserActor(database(), { userId })).resolves.toEqual({
      kind: "user",
      spaceId,
      userId,
      role: "owner",
    });
  });

  it("returns null for a user with no membership", async () => {
    const userId = await insertUser();

    await expect(resolveUserActor(database(), { userId })).resolves.toBeNull();
  });

  it("returns null once the membership is revoked", async () => {
    const userId = await insertUser();
    const spaceId = await insertSpace("My space");
    await insertMembership(spaceId, userId, "member");

    await query("delete from space_member where user_id = $1", [userId]);

    await expect(resolveUserActor(database(), { userId })).resolves.toBeNull();
  });

  it("resolves the same membership every time when a user holds two", async () => {
    const userId = await insertUser();
    const olderSpace = await insertSpace("Older space");
    const newerSpace = await insertSpace("Newer space");
    await insertMembership(newerSpace, userId, "member", "2026-01-02T00:00:00Z");
    await insertMembership(olderSpace, userId, "owner", "2026-01-01T00:00:00Z");

    const first = await resolveUserActor(database(), { userId });
    const second = await resolveUserActor(database(), { userId });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ spaceId: olderSpace, role: "owner" });
  });
});
