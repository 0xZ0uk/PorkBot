import { randomUUID } from "node:crypto";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapSignup, defaultSpaceName } from "../../src/bootstrap.ts";
import { createRepositories } from "../../src/repositories.ts";

/**
 * The bootstrap proven where once-only actually lives: in Postgres.
 *
 * The unit suite proves the command's statements; this suite answers what only
 * a server can. The first signup creates one space and one owner membership;
 * a replay writes nothing; a member-first signup creates the space and a later
 * owner joins it; a second owner request joins as a member and a hand-written
 * second owner row is rejected by `space_member_owner_unique`; two bootstraps
 * racing on separate connections serialize on the advisory lock and leave one
 * space; and the actor the command returns carries the space a repository
 * write stamps onto its rows.
 */

const failure = (
  error: unknown,
): Error & { readonly code?: string; readonly constraint?: string } =>
  error as Error & { readonly code?: string; readonly constraint?: string };

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_bootstrap" });
  client = await connect();
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

beforeEach(async () => {
  // Memberships and sessions cascade from the user; bots and the rest of the
  // runs domain cascade from the space. No test starts with a leftover tenant.
  await db().query('delete from "user"');
  await db().query("delete from space");
});

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

async function connect(): Promise<Client> {
  if (suite === undefined) {
    throw new Error("the suite's database was not created; the beforeAll hook failed first");
  }

  const connection = new Client({ connectionString: suite.connectionString });
  await connection.connect();

  return connection;
}

async function insertUser(name = "Test Operator"): Promise<string> {
  const { rows } = await db().query<{ readonly id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    [name, `${randomUUID()}@example.invalid`],
  );
  const id = rows[0]?.id;

  if (id === undefined) {
    throw new Error("the user insert returned no id");
  }

  return id;
}

async function countRows(table: "space" | "space_member"): Promise<number> {
  const { rows } = await db().query<{ readonly count: string }>(
    `select count(*)::text as count from ${table}`,
  );

  return Number(rows[0]?.count ?? "0");
}

async function countOwners(): Promise<number> {
  const { rows } = await db().query<{ readonly count: string }>(
    "select count(*)::text as count from space_member where role = 'owner'",
  );

  return Number(rows[0]?.count ?? "0");
}

describe("the first signup", () => {
  it("creates exactly one space and one owner membership", async () => {
    const userId = await insertUser();

    const first = await bootstrapSignup(db(), { userId, role: "owner" });

    expect(first.createdSpace).toBe(true);
    expect(first.createdMembership).toBe(true);
    expect(first.actor.kind).toBe("user");
    expect(first.actor.userId).toBe(userId);
    expect(first.actor.role).toBe("owner");

    const spaces = await db().query<{ readonly name: string }>(
      "select name from space order by created_at asc",
    );

    expect(spaces.rows.map((row) => row.name)).toEqual([defaultSpaceName]);

    const members = await db().query<{
      readonly space_id: string;
      readonly user_id: string;
      readonly role: string;
    }>("select space_id::text, user_id::text, role::text from space_member");

    expect(members.rows).toEqual([
      { space_id: first.actor.spaceId, user_id: userId, role: "owner" },
    ]);
  });

  it("is a no-op when run twice, and the first role stands", async () => {
    const userId = await insertUser();

    const first = await bootstrapSignup(db(), { userId, role: "owner" });
    const replay = await bootstrapSignup(db(), { userId, role: "owner" });

    expect(replay.actor).toEqual(first.actor);
    expect(replay.createdSpace).toBe(false);
    expect(replay.createdMembership).toBe(false);
    expect(await countRows("space")).toBe(1);
    expect(await countRows("space_member")).toBe(1);
  });

  it("keeps the space when a member signs up before the owner does", async () => {
    const memberId = await insertUser("Early Member");
    const ownerId = await insertUser("Late Owner");

    const member = await bootstrapSignup(db(), { userId: memberId, role: "member" });
    const owner = await bootstrapSignup(db(), { userId: ownerId, role: "owner" });

    expect(member.createdSpace).toBe(true);
    expect(owner.createdSpace).toBe(false);
    expect(owner.actor.spaceId).toBe(member.actor.spaceId);
    expect(owner.actor.role).toBe("owner");
    expect(await countRows("space")).toBe(1);
    expect(await countOwners()).toBe(1);
  });

  it("returns an actor that scopes a repository write to the space it made", async () => {
    const userId = await insertUser();

    const { actor } = await bootstrapSignup(db(), { userId, role: "owner" });
    const repositories = createRepositories(actor, db());
    const bot = await repositories.bots.create({
      name: "Ada",
      color: "#4f46e5",
      spawnKey: randomUUID(),
    });

    expect(bot.spaceId).toBe(actor.spaceId);
    expect(bot.userId).toBe(userId);

    const { rows } = await db().query<{ readonly space_id: string }>(
      "select space_id::text from bot where id = $1",
      [bot.id],
    );

    expect(rows[0]?.space_id).toBe(actor.spaceId);
  });
});

describe("a second owner request", () => {
  it("joins as a member instead of creating a second owner", async () => {
    const ownerId = await insertUser("First Owner");
    const otherId = await insertUser("Second Owner");

    const owner = await bootstrapSignup(db(), { userId: ownerId, role: "owner" });
    const other = await bootstrapSignup(db(), { userId: otherId, role: "owner" });

    expect(other.actor.spaceId).toBe(owner.actor.spaceId);
    expect(other.actor.role).toBe("member");
    expect(other.createdMembership).toBe(true);
    expect(await countRows("space_member")).toBe(2);
    expect(await countOwners()).toBe(1);
  });

  it("is rejected at the database when a row is written by hand", async () => {
    const ownerId = await insertUser("First Owner");
    const otherId = await insertUser("Second Owner");

    const { actor } = await bootstrapSignup(db(), { userId: ownerId, role: "owner" });

    const failed = await db()
      .query("insert into space_member (space_id, user_id, role) values ($1, $2, 'owner')", [
        actor.spaceId,
        otherId,
      ])
      .catch(failure);

    expect(failed).toMatchObject({
      code: "23505",
      constraint: "space_member_owner_unique",
    });
    expect(await countOwners()).toBe(1);
  });
});

describe("concurrent signups", () => {
  it("serialize on the bootstrap lock, so exactly one space exists", async () => {
    const firstId = await insertUser("First Signup");
    const secondId = await insertUser("Second Signup");
    const first = await connect();
    const second = await connect();

    try {
      const [firstResult, secondResult] = await Promise.all([
        bootstrapSignup(first, { userId: firstId, role: "owner" }),
        bootstrapSignup(second, { userId: secondId, role: "owner" }),
      ]);

      expect(firstResult.actor.spaceId).toBe(secondResult.actor.spaceId);
      expect(await countRows("space")).toBe(1);
      expect(await countRows("space_member")).toBe(2);
      expect(await countOwners()).toBe(1);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it("replays the same registration on two connections without a conflict", async () => {
    const userId = await insertUser("Racing Replay");
    const first = await connect();
    const second = await connect();

    try {
      const [firstResult, secondResult] = await Promise.all([
        bootstrapSignup(first, { userId, role: "owner" }),
        bootstrapSignup(second, { userId, role: "owner" }),
      ]);

      // One call created the rows and the other saw them; the lock is what
      // keeps the loser from hitting `space_member_space_user_unique`.
      expect(firstResult.actor).toEqual(secondResult.actor);
      expect([firstResult.createdMembership, secondResult.createdMembership].sort()).toEqual([
        false,
        true,
      ]);
      expect(await countRows("space")).toBe(1);
      expect(await countRows("space_member")).toBe(1);
    } finally {
      await first.end();
      await second.end();
    }
  });
});
