import { randomUUID } from "node:crypto";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";
import type { UserRepositories } from "../../src/repositories.ts";

/**
 * Run creation proven where the idempotency lives: in Postgres.
 *
 * The unit suite proves the command builds the right statements; this suite
 * runs them on a real server and answers what only a server can. A resubmitted
 * nonce replays the first result and leaves no second run, task or message —
 * sequentially and under parallel connections, where the losing insert waits on
 * the unique index and then reads the winner. The nonce is scoped to the space:
 * the same nonce in another space starts its own run. A thread outside the
 * actor's space is not-found and nothing is written.
 */

const record = (error: unknown): Error => error as Error;

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let alice: UserActor;
let bob: UserActor;
let aliceRepositories: UserRepositories;
let bobRepositories: UserRepositories;
let aliceBot: string;
let bobBot: string;
let aliceThread: string;
let bobThread: string;

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

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_run_creation" });
  client = await connect();

  const spaceA = await insertSpace("Run creation A");
  const spaceB = await insertSpace("Run creation B");
  const aliceId = await insertUser("Alice");
  const bobId = await insertUser("Bob");

  await insertMembership(spaceA, aliceId, "owner");
  await insertMembership(spaceB, bobId, "owner");

  alice = { kind: "user", spaceId: spaceA, userId: aliceId, role: "owner" };
  bob = { kind: "user", spaceId: spaceB, userId: bobId, role: "owner" };
  aliceRepositories = createRepositories(alice, db());
  bobRepositories = createRepositories(bob, db());

  aliceBot = (
    await aliceRepositories.bots.create({ name: "Ada", color: "#4f46e5", spawnKey: randomUUID() })
  ).id;
  bobBot = (
    await bobRepositories.bots.create({ name: "Grace", color: "#059669", spawnKey: randomUUID() })
  ).id;

  aliceThread = (await aliceRepositories.threads.createForBot(aliceBot)).id;
  bobThread = (await bobRepositories.threads.createForBot(bobBot)).id;
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
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

async function insertMembership(spaceId: string, userId: string, role: string): Promise<void> {
  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, $3)", [
    spaceId,
    userId,
    role,
  ]);
}

function requiredId(row: { id: string } | undefined, what: string): string {
  if (row === undefined) {
    throw new Error(`expected ${what} to insert and return its id`);
  }

  return row.id;
}

async function countRows(
  table: string,
  where: string,
  values: readonly unknown[],
): Promise<number> {
  const { rows } = await db().query<{ count: number }>(
    `select count(*)::int as count from ${table} where ${where}`,
    values,
  );

  return rows[0]?.count ?? 0;
}

async function nextMessageSeq(threadId: string): Promise<number> {
  const { rows } = await db().query<{ next_message_seq: number }>(
    "select next_message_seq from thread where id = $1",
    [threadId],
  );

  return rows[0]?.next_message_seq ?? -1;
}

function request(threadId: string, options: { nonce?: string; prompt?: string } = {}) {
  const prompt = options.prompt ?? "summarise the inbox";

  return {
    threadId,
    clientNonce: options.nonce ?? randomUUID(),
    prompt,
    blocks: [{ type: "text", text: prompt }],
  };
}

describe("the run-creation command", () => {
  it("creates the message, task and run and links them both ways", async () => {
    const created = await aliceRepositories.runs.create(request(aliceThread));

    expect(created.run).toMatchObject({
      spaceId: alice.spaceId,
      userId: alice.userId,
      botId: aliceBot,
      threadId: aliceThread,
      taskId: created.task.id,
      sourceMessageId: created.message.id,
      status: "queued",
      trigger: "message",
      leaseFence: 0,
      checkpoint: {},
    });
    expect(created.task).toMatchObject({
      spaceId: alice.spaceId,
      userId: alice.userId,
      botId: aliceBot,
      threadId: aliceThread,
      prompt: "summarise the inbox",
      status: "queued",
    });
    expect(created.message).toMatchObject({
      threadId: aliceThread,
      seq: 0,
      role: "user",
      runId: created.run.id,
      blocks: [{ type: "text", text: "summarise the inbox" }],
    });

    // Read the links back from committed rows, not from the insert's output.
    const { rows } = await db().query<{
      source_message_id: string;
      run_id: string;
      task_id: string;
    }>(
      "select r.source_message_id, m.run_id, r.task_id from run r " +
        "join message m on m.id = r.source_message_id where r.id = $1",
      [created.run.id],
    );

    expect(rows[0]).toEqual({
      source_message_id: created.message.id,
      run_id: created.run.id,
      task_id: created.task.id,
    });
    expect(await nextMessageSeq(aliceThread)).toBe(1);
  });

  it("returns the first result when the same nonce is submitted twice", async () => {
    const seqBefore = await nextMessageSeq(aliceThread);
    const first = await aliceRepositories.runs.create(request(aliceThread));
    const second = await aliceRepositories.runs.create(
      request(aliceThread, { nonce: first.run.clientNonce, prompt: first.task.prompt }),
    );

    expect(second).toEqual(first);
    expect(
      await countRows("run", "space_id = $1 and client_nonce = $2", [
        alice.spaceId,
        first.run.clientNonce,
      ]),
    ).toBe(1);
    expect(
      await countRows("task t", "t.id in (select task_id from run where id = $1)", [first.run.id]),
    ).toBe(1);
    expect(
      await countRows("message", "thread_id = $1 and client_nonce = $2", [
        aliceThread,
        first.run.clientNonce,
      ]),
    ).toBe(1);
    expect(await nextMessageSeq(aliceThread)).toBe(seqBefore + 1);
  });

  it("advances the message position once per accepted submission", async () => {
    const threadId = (await aliceRepositories.threads.createForBot(aliceBot)).id;

    const first = await aliceRepositories.runs.create(request(threadId));
    const second = await aliceRepositories.runs.create(request(threadId));

    expect([first.message.seq, second.message.seq]).toEqual([0, 1]);
    expect(await nextMessageSeq(threadId)).toBe(2);
  });

  it("creates one run for parallel submissions of the same nonce", async () => {
    const threadId = (await aliceRepositories.threads.createForBot(aliceBot)).id;
    const nonce = randomUUID();
    const submitters = await Promise.all(Array.from({ length: 6 }, () => connect()));

    try {
      const results = await Promise.all(
        submitters.map((submitter) =>
          createRepositories(alice, submitter).runs.create(request(threadId, { nonce })),
        ),
      );

      for (const result of results) {
        expect(result).toEqual(results[0]);
      }

      expect(
        await countRows("run", "space_id = $1 and client_nonce = $2", [alice.spaceId, nonce]),
      ).toBe(1);
      expect(await countRows("task", "thread_id = $1", [threadId])).toBe(1);
      expect(await countRows("message", "thread_id = $1", [threadId])).toBe(1);
      expect(await nextMessageSeq(threadId)).toBe(1);
      expect(
        await countRows(
          "task t",
          "t.thread_id = $1 and not exists (select 1 from run r where r.task_id = t.id)",
          [threadId],
        ),
      ).toBe(0);
    } finally {
      await Promise.all(submitters.map((submitter) => submitter.end()));
    }
  });

  it("keeps distinct parallel submissions apart with contiguous positions", async () => {
    const threadId = (await aliceRepositories.threads.createForBot(aliceBot)).id;
    const submitters = await Promise.all(Array.from({ length: 5 }, () => connect()));

    try {
      const results = await Promise.all(
        submitters.map((submitter) =>
          createRepositories(alice, submitter).runs.create(request(threadId)),
        ),
      );

      expect(new Set(results.map((result) => result.run.id)).size).toBe(5);
      expect(results.map((result) => result.message.seq).sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4,
      ]);
      expect(await nextMessageSeq(threadId)).toBe(5);
    } finally {
      await Promise.all(submitters.map((submitter) => submitter.end()));
    }
  });

  it("scopes the nonce to the space, so the same nonce starts a run in each", async () => {
    const nonce = randomUUID();

    const aliceRun = await aliceRepositories.runs.create(request(aliceThread, { nonce }));
    const bobRun = await bobRepositories.runs.create(request(bobThread, { nonce }));

    expect(aliceRun.run.id).not.toBe(bobRun.run.id);
    expect(aliceRun.run.spaceId).toBe(alice.spaceId);
    expect(bobRun.run.spaceId).toBe(bob.spaceId);
  });

  it("returns the first result when the nonce is reused on another thread", async () => {
    const otherThread = (await aliceRepositories.threads.createForBot(aliceBot)).id;
    const nonce = randomUUID();

    const first = await aliceRepositories.runs.create(request(aliceThread, { nonce }));
    const replay = await aliceRepositories.runs.create(request(otherThread, { nonce }));

    expect(replay).toEqual(first);
    expect(await countRows("message", "thread_id = $1", [otherThread])).toBe(0);
    expect(await countRows("task", "thread_id = $1", [otherThread])).toBe(0);
    expect(await nextMessageSeq(otherThread)).toBe(0);
  });

  it("treats another space's thread as not-found and writes nothing", async () => {
    const nonce = randomUUID();
    const tasksBefore = await countRows("task", "thread_id = $1", [bobThread]);
    const messagesBefore = await countRows("message", "thread_id = $1", [bobThread]);

    const rejected = await aliceRepositories.runs
      .create(request(bobThread, { nonce }))
      .catch(record);

    expect(rejected).toMatchObject({ name: "NotFoundError", resource: "thread", id: bobThread });
    expect(await countRows("run", "client_nonce = $1", [nonce])).toBe(0);
    expect(await countRows("task", "thread_id = $1", [bobThread])).toBe(tasksBefore);
    expect(
      await countRows("message", "thread_id = $1 and client_nonce = $2", [bobThread, nonce]),
    ).toBe(0);
    expect(await countRows("message", "thread_id = $1", [bobThread])).toBe(messagesBefore);
  });
});
