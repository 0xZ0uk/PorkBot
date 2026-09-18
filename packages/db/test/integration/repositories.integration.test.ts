import { randomUUID } from "node:crypto";
import { NotFoundError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";
import type { UserRepositories } from "../../src/repositories.ts";

/**
 * The actor scope proven where isolation actually lives: in Postgres.
 *
 * The unit suite proves the layer binds the actor's space into every statement;
 * this suite runs those statements on a real server and answers the questions
 * only a server can. A cross-space read is not-found and indistinguishable from
 * a missing row. A cross-space write changes nothing — the update matches no
 * row, and the thread insert selects over the parent bot in the actor's space,
 * so the foreign bot is not a foreign key error but an empty insert. A system
 * actor carrying a job's space reads exactly that space and carries no write
 * path at all.
 *
 * Actors are built as literals here because 2.9 declares them and slices 3.2
 * and 6.1 mint them (the auth gate and the job dispatcher); the fixture inserts
 * the `space_member` row a real `UserActor` is resolved from, so the shape is
 * the one the gate will produce.
 */

const record = (error: unknown): Error => error as Error;

/** The error with the caller-supplied id masked, so two not-founds are comparable. */
const shapeOf = (error: Error, id: string): string => error.message.replace(id, "<id>");

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let alice: UserActor;
let bob: UserActor;
let aliceRepositories: UserRepositories;
let bobRepositories: UserRepositories;
let botA: string;
let botB: string;
let threadA: string;
let threadB: string;
let runA: string;
let runB: string;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_repositories" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  const spaceA = await insertSpace("Actor A's space");
  const spaceB = await insertSpace("Actor B's space");
  const aliceId = await insertUser("Alice");
  const bobId = await insertUser("Bob");

  await insertMembership(spaceA, aliceId, "owner");
  await insertMembership(spaceB, bobId, "owner");

  alice = { kind: "user", spaceId: spaceA, userId: aliceId, role: "owner" };
  bob = { kind: "user", spaceId: spaceB, userId: bobId, role: "owner" };
  aliceRepositories = createRepositories(alice, db());
  bobRepositories = createRepositories(bob, db());

  const aliceBot = await aliceRepositories.bots.create({
    name: "Ada",
    color: "#4f46e5",
    spawnKey: randomUUID(),
  });
  const bobBot = await bobRepositories.bots.create({
    name: "Grace",
    color: "#059669",
    spawnKey: randomUUID(),
  });
  botA = aliceBot.id;
  botB = bobBot.id;

  threadA = (await aliceRepositories.threads.createForBot(botA)).id;
  threadB = (await bobRepositories.threads.createForBot(botB)).id;

  // Runs are created raw: this slice reads them, slice 2.10 owns the single
  // run-creation command, and slice 6.2 the lease writes.
  const taskA = await insertTask(spaceA, botA, threadA, aliceId);
  const taskB = await insertTask(spaceB, botB, threadB, bobId);
  runA = await insertRun(spaceA, botA, threadA, taskA, aliceId);
  runB = await insertRun(spaceB, botB, threadB, taskB, bobId);
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

function requiredId(row: { id: string } | undefined, what: string): string {
  if (row === undefined) {
    throw new Error(`expected ${what} to insert and return its id`);
  }

  return row.id;
}

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

async function insertMembership(spaceId: string, userId: string, role: string): Promise<void> {
  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, $3)", [
    spaceId,
    userId,
    role,
  ]);
}

async function insertTask(
  spaceId: string,
  botId: string,
  threadId: string,
  userId: string,
): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
      "values ($1, $2, $3, $4, $5, $6) returning id",
    [spaceId, botId, threadId, userId, "do the thing", "queued"],
  );

  return requiredId(rows[0], "a task");
}

async function insertRun(
  spaceId: string,
  botId: string,
  threadId: string,
  taskId: string,
  userId: string,
): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
      "values ($1, $2, $3, $4, $5, 'queued', 'message', $6) returning id",
    [spaceId, botId, threadId, taskId, userId, randomUUID()],
  );

  return requiredId(rows[0], "a run");
}

describe("the bot repository", () => {
  it("writes a created bot into the actor's space, attributed to the actor", async () => {
    const created = await aliceRepositories.bots.create({
      name: "Created",
      color: "#000000",
      spawnKey: randomUUID(),
    });

    expect(created.spaceId).toBe(alice.spaceId);
    expect(created.userId).toBe(alice.userId);
  });

  it("lists only the actor's space", async () => {
    const ids = (await aliceRepositories.bots.list()).map((row) => row.id);

    expect(ids).toContain(botA);
    expect(ids).not.toContain(botB);
  });

  it("makes another space's bot indistinguishable from a missing one", async () => {
    const missingId = randomUUID();
    const foreign = await aliceRepositories.bots.findById(botB).catch(record);
    const missing = await aliceRepositories.bots.findById(missingId).catch(record);

    expect(foreign).toBeInstanceOf(NotFoundError);
    expect((foreign as NotFoundError).resource).toBe("bot");
    // The only difference between the two errors is the id the caller supplied:
    // an out-of-space row is never a different error (a forbidden would leak
    // that the row exists elsewhere).
    expect(shapeOf(foreign, botB)).toBe(shapeOf(missing, missingId));
  });

  it("cannot update across spaces, and leaves the foreign row untouched", async () => {
    const { rows: before } = await db().query<{ name: string }>(
      "select name from bot where id = $1",
      [botB],
    );

    await expect(aliceRepositories.bots.update(botB, { name: "stolen" })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const { rows: after } = await db().query<{ name: string }>(
      "select name from bot where id = $1",
      [botB],
    );

    expect(after[0]?.name).toBe(before[0]?.name);
  });

  it("updates a bot in scope", async () => {
    const updated = await aliceRepositories.bots.update(botA, {
      name: "Ada Lovelace",
      pinned: true,
      position: 2,
    });

    expect(updated).toMatchObject({ id: botA, name: "Ada Lovelace", pinned: true, position: 2 });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());
  });
});

describe("the thread repository", () => {
  it("creates a thread for an in-scope bot, attributed to the actor", async () => {
    const created = await aliceRepositories.threads.createForBot(botA);

    expect(created.spaceId).toBe(alice.spaceId);
    expect(created.userId).toBe(alice.userId);
    expect(created.botId).toBe(botA);
  });

  it("refuses to build a thread on another space's bot and inserts nothing", async () => {
    const before = await countThreads(botB);

    await expect(aliceRepositories.threads.createForBot(botB)).rejects.toMatchObject({
      resource: "bot",
      id: botB,
    });

    expect(await countThreads(botB)).toBe(before);
  });

  it("scopes findById and listForBot", async () => {
    await expect(aliceRepositories.threads.findById(threadB)).rejects.toBeInstanceOf(NotFoundError);

    const foreign = await aliceRepositories.threads.listForBot(botB);
    const own = await aliceRepositories.threads.listForBot(botA);

    expect(foreign).toEqual([]);
    expect(own.map((row) => row.id)).toContain(threadA);
  });
});

describe("the run repository", () => {
  it("scopes findById, with no existence leak", async () => {
    const own = await aliceRepositories.runs.findById(runA);
    expect(own.id).toBe(runA);

    const missingId = randomUUID();
    const foreign = await aliceRepositories.runs.findById(runB).catch(record);
    const missing = await aliceRepositories.runs.findById(missingId).catch(record);

    expect(foreign).toBeInstanceOf(NotFoundError);
    expect((foreign as NotFoundError).resource).toBe("run");
    expect(shapeOf(foreign, runB)).toBe(shapeOf(missing, missingId));
  });

  it("scopes listForThread", async () => {
    expect(await aliceRepositories.runs.listForThread(threadB)).toEqual([]);
    expect((await aliceRepositories.runs.listForThread(threadA)).map((row) => row.id)).toContain(
      runA,
    );
  });
});

describe("the system actor", () => {
  it("reads a background job's own space", async () => {
    const job: SystemActor = { kind: "system", spaceId: alice.spaceId, jobId: randomUUID() };
    const jobRepositories = createRepositories(job, db());

    const own = await jobRepositories.runs.findById(runA);
    expect(own.spaceId).toBe(alice.spaceId);

    await expect(jobRepositories.runs.findById(runB)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("carries no unscoped path and no write surface", () => {
    const job: SystemActor = { kind: "system", spaceId: alice.spaceId, jobId: randomUUID() };
    const jobRepositories = createRepositories(job, db());

    expect(jobRepositories.actor).toBe(job);
    expect("create" in jobRepositories.bots).toBe(false);
    expect("update" in jobRepositories.bots).toBe(false);
    expect("createForBot" in jobRepositories.threads).toBe(false);
  });
});

async function countThreads(botId: string): Promise<number> {
  const { rows } = await db().query<{ count: number }>(
    "select count(*)::int as count from thread where bot_id = $1",
    [botId],
  );

  return rows[0]?.count ?? 0;
}
