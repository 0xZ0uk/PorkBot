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
let dave: UserActor;
let aliceRepositories: UserRepositories;
let bobRepositories: UserRepositories;
let daveRepositories: UserRepositories;
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
  const daveId = await insertUser("Dave");

  await insertMembership(spaceA, aliceId, "owner");
  await insertMembership(spaceB, bobId, "owner");
  // A second member of Alice's space, so a per-user rule is distinguishable
  // from a per-space one even though v1.0 ships one operator per space.
  await insertMembership(spaceA, daveId, "member");

  alice = { kind: "user", spaceId: spaceA, userId: aliceId, role: "owner" };
  bob = { kind: "user", spaceId: spaceB, userId: bobId, role: "owner" };
  dave = { kind: "user", spaceId: spaceA, userId: daveId, role: "member" };
  aliceRepositories = createRepositories(alice, db());
  bobRepositories = createRepositories(bob, db());
  daveRepositories = createRepositories(dave, db());

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

async function insertSteeringMessage(
  botId: string,
  threadId: string,
  userId: string,
): Promise<void> {
  const { rows } = await db().query<{ id: string }>(
    "insert into message (thread_id, seq, role, blocks, client_nonce) " +
      "values ($1, 1, 'user', '[]', $2) returning id",
    [threadId, randomUUID()],
  );
  const messageId = requiredId(rows[0], "a message");

  await db().query(
    "insert into steering_message (message_id, bot_id, user_id) values ($1, $2, $3)",
    [messageId, botId, userId],
  );
}

async function insertEvent(
  spaceId: string,
  threadId: string,
  seq: number,
  runId: string,
): Promise<void> {
  await db().query(
    "insert into event (space_id, thread_id, seq, type, payload, run_id) " +
      "values ($1, $2, $3, 'run.started', '{}', $4)",
    [spaceId, threadId, seq, runId],
  );
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

describe("the event replay read", () => {
  it("reads strictly after the cursor, in order, scoped to the actor's space", async () => {
    await insertEvent(alice.spaceId, threadA, 1, runA);
    await insertEvent(alice.spaceId, threadA, 2, runA);
    await insertEvent(alice.spaceId, threadA, 3, runA);
    await insertEvent(bob.spaceId, threadB, 1, runB);

    const all = await aliceRepositories.events.listAfter(threadA, 0, 10);

    expect(all.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(all[0]).toMatchObject({ threadId: threadA, runId: runA, type: "run.started" });

    const afterCursor = await aliceRepositories.events.listAfter(threadA, 2, 10);
    expect(afterCursor.map((row) => row.seq)).toEqual([3]);

    const page = await aliceRepositories.events.listAfter(threadA, 0, 2);
    expect(page.map((row) => row.seq)).toEqual([1, 2]);

    // Another space's event rows and another space's thread both read as
    // nothing, the same way every other scoped read behaves.
    expect(await aliceRepositories.events.listAfter(threadB, 0, 10)).toEqual([]);
    expect(await bobRepositories.events.listAfter(threadB, 0, 10)).toHaveLength(1);
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

describe("the bot lifecycle", () => {
  it("archives out of the default list and restores back into it", async () => {
    const bot = await aliceRepositories.bots.create({
      name: "Archivable",
      color: "#111111",
      spawnKey: randomUUID(),
    });

    const archived = await aliceRepositories.bots.archive(bot.id);
    expect(archived.archivedAt).not.toBeNull();

    expect((await aliceRepositories.bots.list()).map((row) => row.id)).not.toContain(bot.id);
    expect((await aliceRepositories.bots.list("archived")).map((row) => row.id)).toContain(bot.id);
    expect((await aliceRepositories.bots.list("all")).map((row) => row.id)).toContain(bot.id);

    // Archiving again keeps the first instant: the state is the same state.
    const again = await aliceRepositories.bots.archive(bot.id);
    expect(again.archivedAt?.getTime()).toBe(archived.archivedAt?.getTime());

    const restored = await aliceRepositories.bots.restore(bot.id);
    expect(restored.archivedAt).toBeNull();
    expect((await aliceRepositories.bots.list()).map((row) => row.id)).toContain(bot.id);
  });

  it("refuses another space's bot for every write, and changes nothing", async () => {
    await expect(aliceRepositories.bots.archive(botB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(aliceRepositories.bots.restore(botB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(aliceRepositories.bots.delete(botB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      aliceRepositories.bots.setAvatar(botB, "avatars/space-x/bot"),
    ).rejects.toBeInstanceOf(NotFoundError);

    const { rows } = await db().query<{ archived_at: Date | null; avatar_key: string | null }>(
      "select archived_at, avatar_key from bot where id = $1",
      [botB],
    );

    expect(rows[0]?.archived_at).toBeNull();
    expect(rows[0]?.avatar_key).toBeNull();
  });

  it("deletes a bot with its threads, tasks and runs in one statement", async () => {
    const bot = await aliceRepositories.bots.create({
      name: "Doomed",
      color: "#222222",
      spawnKey: randomUUID(),
    });
    const thread = await aliceRepositories.threads.createForBot(bot.id);
    const task = await insertTask(alice.spaceId, bot.id, thread.id, alice.userId);
    await insertRun(alice.spaceId, bot.id, thread.id, task, alice.userId);
    await insertSteeringMessage(bot.id, thread.id, alice.userId);

    const removed = await aliceRepositories.bots.delete(bot.id);
    expect(removed.id).toBe(bot.id);

    for (const table of ["thread", "task", "run", "steering_message"] as const) {
      const { rows } = await db().query<{ count: number }>(
        `select count(*)::int as count from ${table} where bot_id = $1`,
        [bot.id],
      );

      expect(rows[0]?.count, `${table} rows cascade with the bot`).toBe(0);
    }
  });

  it("replays a create with the same spawn key instead of inserting a second bot", async () => {
    const spawnKey = randomUUID();
    const first = await aliceRepositories.bots.create({
      name: "Replay",
      color: "#333333",
      spawnKey,
    });
    const replay = await aliceRepositories.bots.create({
      name: "Replay renamed",
      color: "#333333",
      spawnKey,
    });

    expect(replay.id).toBe(first.id);
    expect(replay.name).toBe("Replay");

    const { rows } = await db().query<{ count: number }>(
      "select count(*)::int as count from bot where space_id = $1 and spawn_key = $2",
      [alice.spaceId, spawnKey],
    );

    expect(rows[0]?.count).toBe(1);
  });

  it("stores, updates and clears the computer assignment", async () => {
    const computerId = randomUUID();
    const bot = await aliceRepositories.bots.create({
      name: "Assigned",
      color: "#666666",
      spawnKey: randomUUID(),
      computerId,
    });

    expect(bot.computerId).toBe(computerId);

    const reassigned = await aliceRepositories.bots.update(bot.id, { computerId: randomUUID() });
    expect(reassigned.computerId).not.toBe(computerId);

    const cleared = await aliceRepositories.bots.update(bot.id, { computerId: null });
    expect(cleared.computerId).toBeNull();
  });

  it("stores and clears the avatar key in scope", async () => {
    const bot = await aliceRepositories.bots.create({
      name: "Avatar",
      color: "#444444",
      spawnKey: randomUUID(),
    });

    const keyed = await aliceRepositories.bots.setAvatar(bot.id, "avatars/space/bot");
    expect(keyed.avatarKey).toBe("avatars/space/bot");

    const cleared = await aliceRepositories.bots.setAvatar(bot.id, null);
    expect(cleared.avatarKey).toBeNull();
  });
});

describe("bot sections", () => {
  it("creates a section in the actor's space, renames it and unfiles its bots on delete", async () => {
    const section = await aliceRepositories.sections.create({ name: "Research" });
    expect(section.spaceId).toBe(alice.spaceId);
    expect(section.userId).toBe(alice.userId);

    const bot = await aliceRepositories.bots.create({
      name: "Filed",
      color: "#444444",
      spawnKey: randomUUID(),
      sectionId: section.id,
    });
    expect(bot.sectionId).toBe(section.id);

    const renamed = await aliceRepositories.sections.update(section.id, {
      name: "Lab",
      position: 5,
    });
    expect(renamed).toMatchObject({ name: "Lab", position: 5 });

    const deleted = await aliceRepositories.sections.delete(section.id);
    expect(deleted.id).toBe(section.id);
    expect((await aliceRepositories.bots.findById(bot.id)).sectionId).toBeNull();
  });

  it("refuses a duplicate section name on create and on rename", async () => {
    await aliceRepositories.sections.create({ name: "Taken" });
    await expect(aliceRepositories.sections.create({ name: "Taken" })).rejects.toMatchObject({
      _tag: "NameConflictError",
    });

    const other = await aliceRepositories.sections.create({ name: "Other" });
    await expect(
      aliceRepositories.sections.update(other.id, { name: "Taken" }),
    ).rejects.toMatchObject({ _tag: "NameConflictError" });
    expect((await aliceRepositories.sections.update(other.id, { name: "Free" })).name).toBe("Free");
  });

  it("refuses another space's section on a bot, and another space's section on update/delete", async () => {
    const bobSection = await bobRepositories.sections.create({ name: "Bob's list" });
    const spawnKey = randomUUID();

    await expect(
      aliceRepositories.bots.create({
        name: "Misfiled",
        color: "#555555",
        spawnKey,
        sectionId: bobSection.id,
      }),
    ).rejects.toMatchObject({ resource: "bot section", id: bobSection.id });
    expect((await aliceRepositories.bots.list("all")).map((row) => row.spawnKey)).not.toContain(
      spawnKey,
    );

    const bot = await aliceRepositories.bots.create({
      name: "Safe",
      color: "#555555",
      spawnKey: randomUUID(),
    });
    await expect(
      aliceRepositories.bots.update(bot.id, { sectionId: bobSection.id }),
    ).rejects.toMatchObject({ resource: "bot section", id: bobSection.id });
    expect((await aliceRepositories.bots.findById(bot.id)).sectionId).toBeNull();

    await expect(
      aliceRepositories.sections.update(bobSection.id, { name: "stolen" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(aliceRepositories.sections.delete(bobSection.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect((await bobRepositories.sections.list()).map((row) => row.id)).toContain(bobSection.id);
  });

  it("lists only the actor's sections", async () => {
    const bobSection = await bobRepositories.sections.create({ name: "Bob only" });

    expect((await aliceRepositories.sections.list()).map((row) => row.id)).not.toContain(
      bobSection.id,
    );
  });

  it("keeps a section private to the user who named it, even inside one space", async () => {
    const daveSection = await daveRepositories.sections.create({ name: "Dave's list" });

    expect((await aliceRepositories.sections.list()).map((row) => row.id)).not.toContain(
      daveSection.id,
    );
    await expect(
      aliceRepositories.sections.update(daveSection.id, { name: "stolen" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(aliceRepositories.sections.delete(daveSection.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const spawnKey = randomUUID();

    await expect(
      aliceRepositories.bots.create({
        name: "Misfiled",
        color: "#777777",
        spawnKey,
        sectionId: daveSection.id,
      }),
    ).rejects.toMatchObject({ resource: "bot section", id: daveSection.id });
    expect((await aliceRepositories.bots.list("all")).map((row) => row.spawnKey)).not.toContain(
      spawnKey,
    );

    // The name is unique per user, so the same name is not a conflict for
    // another member of the space.
    const aliceSection = await aliceRepositories.sections.create({ name: "Dave's list" });
    expect(aliceSection.userId).toBe(alice.userId);
  });
});

async function countThreads(botId: string): Promise<number> {
  const { rows } = await db().query<{ count: number }>(
    "select count(*)::int as count from thread where bot_id = $1",
    [botId],
  );

  return rows[0]?.count ?? 0;
}
