import { randomUUID } from "node:crypto";
import { NotFoundError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";

/**
 * Notification preferences proven where access control lives: in Postgres.
 *
 * The unit suite proves the statements' shape over a fake client; this suite
 * answers what only a server can. The quiet default is the absence of a row, a
 * set upserts one switch instead of growing rows, the switches are per space
 * and per user — a second user and a second space read their own defaults — and
 * the delivery path's eligibility joins the membership, so a user outside the
 * space is `not_a_recipient` even if they hold a preference row elsewhere and
 * even after their membership is removed. Deleting the space cascades the rows
 * away.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let spaceA: string;
let spaceB: string;
let aliceId: string;
let bobId: string;
let carolId: string;

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_notifications" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  spaceA = await insertSpace("Notifications A");
  spaceB = await insertSpace("Notifications B");
  aliceId = await insertUser("Alice");
  bobId = await insertUser("Bob");
  carolId = await insertUser("Carol");
  await insertMembership(spaceA, aliceId, "owner");
  await insertMembership(spaceA, bobId, "member");
  await insertMembership(spaceB, carolId, "owner");
}, 180_000);

// Every test starts from the quiet default: the switches written by one test
// cannot make another's assertions pass or fail.
beforeEach(async () => {
  await db().query("delete from notification_preference where space_id = any($1::uuid[])", [
    [spaceA, spaceB],
  ]);
});

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

function systemActor(spaceId: string): SystemActor {
  return { kind: "system", spaceId, jobId: `job-${randomUUID()}` };
}

function operator(spaceId: string, userId: string): UserActor {
  return { kind: "user", spaceId, userId, role: "owner" };
}

function switchesFor(userId: string, spaceId: string = spaceA) {
  return createRepositories(operator(spaceId, userId), db()).notifications;
}

function eligibilityFor(spaceId: string) {
  return createRepositories(systemActor(spaceId), db()).notifications;
}

describe("the operator's switches", () => {
  it("starts quiet and flips exactly the kinds that were set", async () => {
    const notifications = switchesFor(aliceId);

    await expect(notifications.read()).resolves.toEqual({
      "run.completed": false,
      "run.failed": false,
      "run.needs_approval": false,
      "run.stalled": false,
    });

    await expect(notifications.set("run.failed", true)).resolves.toMatchObject({
      "run.failed": true,
      "run.completed": false,
    });

    await notifications.set("run.failed", false);
    await notifications.set("run.stalled", true);

    await expect(notifications.read()).resolves.toEqual({
      "run.completed": false,
      "run.failed": false,
      "run.needs_approval": false,
      "run.stalled": true,
    });
  });

  it("upserts one row per kind rather than growing history", async () => {
    const notifications = switchesFor(aliceId);

    await notifications.set("run.completed", true);
    await notifications.set("run.completed", true);
    await notifications.set("run.completed", false);
    await notifications.set("run.completed", true);

    const { rows } = await db().query<{ readonly count: number }>(
      "select count(*)::int as count from notification_preference " +
        "where space_id = $1 and user_id = $2 and kind = 'run.completed'",
      [spaceA, aliceId],
    );

    expect(rows[0]?.count).toBe(1);
  });

  it("keeps one operator's switches out of another's read", async () => {
    await switchesFor(aliceId).set("run.needs_approval", true);
    await switchesFor(bobId).set("run.stalled", true);

    const aliceView = await switchesFor(aliceId).read();
    const bobView = await switchesFor(bobId).read();

    expect(aliceView).toEqual({
      "run.completed": false,
      "run.failed": false,
      "run.needs_approval": true,
      "run.stalled": false,
    });
    expect(bobView).toEqual({
      "run.completed": false,
      "run.failed": false,
      "run.needs_approval": false,
      "run.stalled": true,
    });
  });

  it("answers the quiet default rather than another space's row", async () => {
    await switchesFor(carolId, spaceB).set("run.failed", true);

    const inB = await switchesFor(carolId, spaceB).read();
    const inA = await switchesFor(aliceId, spaceA).read();

    expect(inB["run.failed"]).toBe(true);
    expect(inA["run.failed"]).toBe(false);
  });

  it("refuses a set from an actor with no membership and writes no row", async () => {
    const ghostId = randomUUID();

    await expect(switchesFor(ghostId).set("run.failed", true)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const { rows } = await db().query<{ readonly count: number }>(
      "select count(*)::int as count from notification_preference where user_id = $1",
      [ghostId],
    );

    expect(rows[0]?.count).toBe(0);
  });
});

describe("the delivery path's eligibility", () => {
  it("answers enabled for a member whose switch is on", async () => {
    await switchesFor(aliceId).set("run.needs_approval", true);

    await expect(eligibilityFor(spaceA).eligibility(aliceId, "run.needs_approval")).resolves.toBe(
      "enabled",
    );
  });

  it("answers disabled for a member who left the switch quiet", async () => {
    await switchesFor(bobId).set("run.stalled", true);

    await expect(eligibilityFor(spaceA).eligibility(bobId, "run.completed")).resolves.toBe(
      "disabled",
    );
    await expect(eligibilityFor(spaceA).eligibility(bobId, "run.stalled")).resolves.toBe("enabled");
  });

  it("answers not_a_recipient for a user who is not a member of the space", async () => {
    // Carol holds a preference row in her own space; a job in space A must not
    // reach her through it.
    await switchesFor(carolId, spaceB).set("run.failed", true);

    await expect(eligibilityFor(spaceA).eligibility(carolId, "run.failed")).resolves.toBe(
      "not_a_recipient",
    );
  });

  it("answers not_a_recipient for an id that cannot name a member", async () => {
    await expect(eligibilityFor(spaceA).eligibility("not-a-uuid", "run.failed")).resolves.toBe(
      "not_a_recipient",
    );
  });

  it("stops notifying once the membership is gone, even though the row remains", async () => {
    const spaceC = await insertSpace("Notifications C");
    const daveId = await insertUser("Dave");
    await insertMembership(spaceC, daveId, "owner");

    await switchesFor(daveId, spaceC).set("run.failed", true);

    await expect(eligibilityFor(spaceC).eligibility(daveId, "run.failed")).resolves.toBe("enabled");

    await db().query("delete from space_member where space_id = $1 and user_id = $2", [
      spaceC,
      daveId,
    ]);

    await expect(eligibilityFor(spaceC).eligibility(daveId, "run.failed")).resolves.toBe(
      "not_a_recipient",
    );

    // A set from the now-former member is refused rather than answering a
    // success that wrote nothing.
    await expect(switchesFor(daveId, spaceC).set("run.stalled", true)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // The row is deliberately still there: the membership, not the row's
    // existence, is what authorizes a notification.
    const { rows } = await db().query<{ readonly count: number }>(
      "select count(*)::int as count from notification_preference " +
        "where space_id = $1 and user_id = $2",
      [spaceC, daveId],
    );

    expect(rows[0]?.count).toBe(1);

    await db().query("delete from space where id = $1", [spaceC]);
  });

  it("cascades the switches away with the space", async () => {
    const spaceD = await insertSpace("Notifications D");
    const erinId = await insertUser("Erin");
    await insertMembership(spaceD, erinId, "owner");

    await switchesFor(erinId, spaceD).set("run.completed", true);

    await db().query("delete from space where id = $1", [spaceD]);

    const { rows } = await db().query<{ readonly count: number }>(
      "select count(*)::int as count from notification_preference where space_id = $1",
      [spaceD],
    );

    expect(rows[0]?.count).toBe(0);
  });
});

async function insertSpace(name: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into space (name) values ($1) returning id",
    [name],
  );

  return requiredId(rows[0], "a space");
}

async function insertUser(name: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id',
    [name, `${randomUUID()}@example.test`],
  );

  return requiredId(rows[0], "a user");
}

async function insertMembership(spaceId: string, memberId: string, role: string): Promise<void> {
  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, $3)", [
    spaceId,
    memberId,
    role,
  ]);
}

function requiredId(row: { id: string } | undefined, what: string): string {
  if (row === undefined) {
    throw new Error(`expected ${what} to insert and return its id`);
  }

  return row.id;
}
