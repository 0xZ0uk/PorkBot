import { randomUUID } from "node:crypto";
import { NotFoundError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";

/**
 * Token usage proven where the records live: in Postgres (slice 8.8, story
 * 34).
 *
 * The unit suite proves the statements' shape over a fake client; this suite
 * answers what only a server can. The append derives the row's bot and space
 * from the run it names, the aggregate sums only reported figures and answers
 * null when nothing was reported, the daily buckets are real UTC days, the
 * all-time total is not windowed while the buckets are, and both directions of
 * the actor scope hold.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let spaceA: string;
let spaceB: string;
let aliceId: string;
let carolId: string;
let botId: string;
let runId: string;

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_usage" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  spaceA = await insertSpace("Usage A");
  spaceB = await insertSpace("Usage B");
  aliceId = await insertUser("Alice");
  carolId = await insertUser("Carol");
  await insertMembership(spaceA, aliceId, "owner");
  await insertMembership(spaceB, carolId, "owner");

  const owner = operator(spaceA, aliceId);
  const repositories = createRepositories(owner, db());
  const bot = await repositories.bots.create({
    name: "Usage bot",
    color: "#4f46e5",
    spawnKey: randomUUID(),
  });
  const thread = await repositories.threads.createForBot(bot.id);
  const created = await repositories.runs.create({
    threadId: thread.id,
    clientNonce: randomUUID(),
    prompt: "spend some tokens",
    blocks: [],
  });

  botId = bot.id;
  runId = created.run.id;
}, 180_000);

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

function recorder(spaceId: string = spaceA) {
  return createRepositories(systemActor(spaceId), db()).usage;
}

function reader(spaceId: string = spaceA, userId: string = aliceId) {
  return createRepositories(operator(spaceId, userId), db()).usage;
}

async function record(
  usage: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  },
  spaceId: string = spaceA,
): Promise<void> {
  await recorder(spaceId).record({ runId, ...usage });
}

/** Moves one record's instant so a bucket other than today can be asserted. */
async function backdate(days: number, provider: string): Promise<void> {
  await db().query(
    "update usage_record set created_at = now() - make_interval(days => $1::int) " +
      "where run_id = $2 and provider = $3",
    [days, runId, provider],
  );
}

async function clearUsage(): Promise<void> {
  await db().query("delete from usage_record where bot_id = $1", [botId]);
}

describe("the recorded ledger", () => {
  it("derives the bot and the space from the run and totals what was reported", async () => {
    await clearUsage();
    await record({
      provider: "openai",
      model: "gpt-test",
      inputTokens: 1200,
      outputTokens: 340,
    });

    const { rows } = await db().query<{
      readonly botId: string;
      readonly spaceId: string;
      readonly provider: string;
    }>('select bot_id as "botId", space_id as "spaceId", provider from usage_record', []);

    expect(rows).toEqual([{ botId, spaceId: spaceA, provider: "openai" }]);

    const summary = await reader().forBot(botId, { since: new Date(0) });

    expect(summary.total).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      reported: 1,
      unreported: 0,
    });
  });

  it("keeps an unreported turn null rather than coalescing a zero", async () => {
    await clearUsage();
    await record({ provider: null, model: null, inputTokens: null, outputTokens: null });

    const summary = await reader().forBot(botId, { since: new Date(0) });

    expect(summary.total).toEqual({
      inputTokens: null,
      outputTokens: null,
      reported: 0,
      unreported: 1,
    });
  });

  it("sums only reported figures and counts the calls behind them", async () => {
    await clearUsage();
    await record({ provider: "openai", model: "gpt-test", inputTokens: 100, outputTokens: 10 });
    await record({ provider: "openai", model: "gpt-test", inputTokens: null, outputTokens: null });
    await record({ provider: "openai", model: "gpt-test", inputTokens: 50, outputTokens: 5 });

    const summary = await reader().forBot(botId, { since: new Date(0) });

    expect(summary.total).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      reported: 2,
      unreported: 1,
    });
  });

  it("buckets by UTC day, newest first, while the total stays all-time", async () => {
    await clearUsage();
    await record({ provider: "old", model: "gpt-test", inputTokens: 10, outputTokens: 1 });
    await backdate(40, "old");
    await record({ provider: "yesterday", model: "gpt-test", inputTokens: 20, outputTokens: 2 });
    await backdate(1, "yesterday");
    await record({ provider: "today", model: "gpt-test", inputTokens: 30, outputTokens: 3 });

    const summary = await reader().forBot(botId, { since: utcMidnightDaysAgo(1) });

    // The 40-day-old record is outside the window: the total keeps it, the
    // buckets do not.
    expect(summary.total.inputTokens).toBe(60);
    expect(summary.total.outputTokens).toBe(6);
    expect(summary.periods).toHaveLength(2);
    expect(summary.periods[0]?.startsAt.toISOString()).toBe(utcMidnightDaysAgo(0).toISOString());
    expect(summary.periods[0]?.inputTokens).toBe(30);
    expect(summary.periods[1]?.startsAt.toISOString()).toBe(utcMidnightDaysAgo(1).toISOString());
    expect(summary.periods[1]?.inputTokens).toBe(20);
  });

  it("refuses a foreign run's append and a foreign bot's read", async () => {
    await clearUsage();

    await expect(
      record({ provider: "openai", model: "gpt-test", inputTokens: 1, outputTokens: 1 }, spaceB),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      reader(spaceB, carolId).forBot(botId, { since: new Date(0) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("takes the usage rows with the run when the run is deleted", async () => {
    await clearUsage();
    await record({ provider: "openai", model: "gpt-test", inputTokens: 1, outputTokens: 1 });

    await db().query("delete from run where id = $1", [runId]);

    const { rows } = await db().query<{ readonly count: number }>(
      "select count(*)::int as count from usage_record where bot_id = $1",
      [botId],
    );

    expect(rows[0]?.count).toBe(0);
  });
});

function utcMidnightDaysAgo(days: number): Date {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

async function insertSpace(name: string): Promise<string> {
  const { rows } = await db().query<{ readonly id: string }>(
    "insert into space (name) values ($1) returning id::text as id",
    [name],
  );
  const space = rows[0];

  if (space === undefined) {
    throw new Error(`insertSpace: no id for ${name}`);
  }

  return space.id;
}

async function insertUser(name: string): Promise<string> {
  const { rows } = await db().query<{ readonly id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    [name, `${randomUUID()}@example.test`],
  );
  const user = rows[0];

  if (user === undefined) {
    throw new Error(`insertUser: no id for ${name}`);
  }

  return user.id;
}

async function insertMembership(
  spaceId: string,
  userId: string,
  role: "owner" | "member",
): Promise<void> {
  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, $3)", [
    spaceId,
    userId,
    role,
  ]);
}
