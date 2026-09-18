import { randomUUID } from "node:crypto";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The slice 2.3 rules proven where they live: in Postgres. The unit suite reads
 * the schema; this suite writes rows and makes the database refuse the ones the
 * schema claims it refuses — an illegal status, a NULL idempotency key, a
 * duplicate scoped key, a NULL checkpoint, a reused (thread, seq) position —
 * and proves the identity foreign keys do what their delete actions say.
 *
 * The migration runs the same way production does: the suite is a clone of the
 * testkit template (`packages/db/migrations` applied in order), so a migration
 * that does not apply fails here before it can fail a deployment.
 */

const space = randomUUID();
const otherSpace = randomUUID();
const user = randomUUID();
const otherUser = randomUUID();

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_runs_domain" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  // The runs tables are foreign keys into identity and tenancy now, so the
  // fixtures need the parent rows the identity tier's suites own.
  await db().query("insert into space (id, name) values ($1, $2), ($3, $4)", [
    space,
    "runs domain",
    otherSpace,
    "another space",
  ]);
  await db().query('insert into "user" (id, name, email) values ($1, $2, $3), ($4, $5, $6)', [
    user,
    "fixture user",
    `runs-${user}@example.test`,
    otherUser,
    "other fixture user",
    `other-${otherUser}@example.test`,
  ]);
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

async function createBot(
  options: { spaceId?: string; userId?: string; spawnKey?: string } = {},
): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into bot (space_id, user_id, name, color, spawn_key) values ($1, $2, $3, $4, $5) returning id",
    [
      options.spaceId ?? space,
      options.userId ?? user,
      `bot-${randomUUID()}`,
      "#000000",
      options.spawnKey ?? randomUUID(),
    ],
  );

  return requiredId(rows[0], "a bot");
}

async function createThread(botId: string, spaceId = space): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into thread (space_id, bot_id, user_id) values ($1, $2, $3) returning id",
    [spaceId, botId, user],
  );

  return requiredId(rows[0], "a thread");
}

async function createTask(botId: string, threadId: string, spaceId = space): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
      "values ($1, $2, $3, $4, $5, $6) returning id",
    [spaceId, botId, threadId, user, "do the thing", "queued"],
  );

  return requiredId(rows[0], "a task");
}

async function createRun(
  options: { spaceId?: string; clientNonce?: string } = {},
): Promise<string> {
  const runSpace = options.spaceId ?? space;
  const botId = await createBot({ spaceId: runSpace });
  const threadId = await createThread(botId, runSpace);
  const taskId = await createTask(botId, threadId, runSpace);

  const { rows } = await db().query<{ id: string }>(
    "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
      "values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
    [
      runSpace,
      botId,
      threadId,
      taskId,
      user,
      "queued",
      "message",
      options.clientNonce ?? randomUUID(),
    ],
  );

  return requiredId(rows[0], "a run");
}

describe("typed statuses in the database", () => {
  it("rejects a run status outside the run_status enum", async () => {
    const botId = await createBot();
    const threadId = await createThread(botId);
    const taskId = await createTask(botId, threadId);

    await expect(
      db().query(
        "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
          "values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [space, botId, threadId, taskId, user, "pretending", "message", randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "22P02" });
  });

  it("rejects a task status outside the task_status enum", async () => {
    const botId = await createBot();
    const threadId = await createThread(botId);

    await expect(
      db().query(
        "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
          "values ($1, $2, $3, $4, $5, $6)",
        [space, botId, threadId, user, "do the thing", "sideways"],
      ),
    ).rejects.toMatchObject({ code: "22P02" });
  });

  it("rejects an attempt status outside the attempt_status enum", async () => {
    const runId = await createRun();

    await expect(
      db().query("insert into attempt (run_id, fence, status) values ($1, $2, $3)", [
        runId,
        0,
        "wandering",
      ]),
    ).rejects.toMatchObject({ code: "22P02" });
  });

  it("rejects an effect status outside the effect_status enum", async () => {
    const runId = await createRun();

    await expect(
      db().query(
        "insert into external_effect (space_id, run_id, kind, idempotency_key, status, request) " +
          "values ($1, $2, $3, $4, $5, $6)",
        [space, runId, "http.request", randomUUID(), "maybe", "{}"],
      ),
    ).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("idempotency keys in the database", () => {
  it("refuses a NULL key on every idempotent table", async () => {
    const botId = await createBot();
    const threadId = await createThread(botId);
    const runId = await createRun();

    const nullKeyInserts = [
      {
        what: "bot.spawn_key",
        text: "insert into bot (space_id, user_id, name, color, spawn_key) values ($1, $2, $3, $4, null)",
        values: [space, user, "no key", "#000000"],
      },
      {
        what: "message.client_nonce",
        text: "insert into message (thread_id, seq, role, blocks, client_nonce) values ($1, $2, $3, $4, null)",
        values: [threadId, 1, "user", "[]"],
      },
      {
        what: "run.client_nonce",
        text:
          "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
          "select space_id, bot_id, thread_id, task_id, user_id, 'queued', 'message', null from run where id = $1",
        values: [runId],
      },
      {
        what: "external_effect.idempotency_key",
        text:
          "insert into external_effect (space_id, run_id, kind, idempotency_key, status, request) " +
          "values ($1, $2, $3, null, $4, $5)",
        values: [space, runId, "http.request", "pending", "{}"],
      },
    ];

    for (const { what, text, values } of nullKeyInserts) {
      await expect(db().query(text, values), `${what} must reject NULL`).rejects.toMatchObject({
        code: "23502",
      });
    }
  });

  it("refuses a duplicate bot spawn key in one space and allows it in another", async () => {
    const spawnKey = randomUUID();
    await createBot({ spawnKey });

    await expect(createBot({ spawnKey })).rejects.toMatchObject({ code: "23505" });
    await expect(createBot({ spawnKey, spaceId: otherSpace })).resolves.toEqual(expect.any(String));
  });

  it("refuses a duplicate message nonce in one thread and allows it in another", async () => {
    const botId = await createBot();
    const threadId = await createThread(botId);
    const otherThreadId = await createThread(botId);
    const clientNonce = randomUUID();
    const insert = (targetThreadId: string, seq: number): Promise<unknown> =>
      db().query(
        "insert into message (thread_id, seq, role, blocks, client_nonce) values ($1, $2, $3, $4, $5)",
        [targetThreadId, seq, "user", "[]", clientNonce],
      );

    await insert(threadId, 1);
    await expect(insert(threadId, 2)).rejects.toMatchObject({ code: "23505" });
    await expect(insert(otherThreadId, 1)).resolves.toBeDefined();
  });

  it("refuses a duplicate run nonce in one space and allows it in another", async () => {
    const clientNonce = randomUUID();
    await createRun({ clientNonce });

    await expect(createRun({ clientNonce })).rejects.toMatchObject({ code: "23505" });
    await expect(createRun({ clientNonce, spaceId: otherSpace })).resolves.toEqual(
      expect.any(String),
    );
  });

  it("refuses a duplicate effect key on one run and allows it on another", async () => {
    const runId = await createRun();
    const otherRunId = await createRun();
    const idempotencyKey = randomUUID();
    const insert = (targetRunId: string): Promise<unknown> =>
      db().query(
        "insert into external_effect (space_id, run_id, kind, idempotency_key, status, request) " +
          "values ($1, $2, $3, $4, $5, $6)",
        [space, targetRunId, "http.request", idempotencyKey, "pending", "{}"],
      );

    await insert(runId);
    await expect(insert(runId)).rejects.toMatchObject({ code: "23505" });
    await expect(insert(otherRunId)).resolves.toBeDefined();
  });

  it("refuses a second attempt for a fence and a second steering row for a message", async () => {
    const runId = await createRun();
    await db().query("insert into attempt (run_id, fence, status) values ($1, 0, 'running')", [
      runId,
    ]);
    await expect(
      db().query("insert into attempt (run_id, fence, status) values ($1, 0, 'running')", [runId]),
    ).rejects.toMatchObject({ code: "23505" });

    const botId = await createBot();
    const threadId = await createThread(botId);
    const { rows } = await db().query<{ id: string }>(
      "insert into message (thread_id, seq, role, blocks, client_nonce) values ($1, 1, 'user', '[]', $2) returning id",
      [threadId, randomUUID()],
    );
    const messageId = requiredId(rows[0], "a steering message");

    await db().query(
      "insert into steering_message (message_id, bot_id, user_id) values ($1, $2, $3)",
      [messageId, botId, user],
    );
    await expect(
      db().query("insert into steering_message (message_id, bot_id, user_id) values ($1, $2, $3)", [
        messageId,
        botId,
        user,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("the run lease and checkpoint", () => {
  it("guards writes on a monotonically increasing fence", async () => {
    const runId = await createRun();

    const claim = await db().query<{ lease_fence: number; lease_owner: string }>(
      "update run set lease_owner = $2, lease_fence = lease_fence + 1, " +
        "lease_expires_at = now() + interval '5 minutes' " +
        "where id = $1 and lease_fence = 0 returning lease_fence, lease_owner",
      [runId, "worker-a"],
    );

    expect(claim.rowCount).toBe(1);
    expect(claim.rows[0]?.lease_fence).toBe(1);

    // The stale owner's heartbeat matches no row and renews nothing.
    const stale = await db().query(
      "update run set lease_fence = lease_fence + 1, lease_owner = 'worker-b' " +
        "where id = $1 and lease_fence = 0",
      [runId],
    );

    expect(stale.rowCount).toBe(0);

    const after = await db().query<{ lease_fence: number; lease_owner: string }>(
      "select lease_fence, lease_owner from run where id = $1",
      [runId],
    );

    expect(after.rows[0]).toEqual({ lease_fence: 1, lease_owner: "worker-a" });

    // The current fence claims the next one, so the counter only moves forward.
    const reclaim = await db().query<{ lease_fence: number }>(
      "update run set lease_fence = lease_fence + 1 where id = $1 and lease_fence = 1 returning lease_fence",
      [runId],
    );

    expect(reclaim.rowCount).toBe(1);
    expect(reclaim.rows[0]?.lease_fence).toBe(2);
  });

  it("never lets the checkpoint be NULL", async () => {
    const runId = await createRun();

    await expect(
      db().query("update run set checkpoint = null where id = $1", [runId]),
    ).rejects.toMatchObject({ code: "23502" });
  });
});

describe("thread ordering in the database", () => {
  it("refuses a reused message position", async () => {
    const botId = await createBot();
    const threadId = await createThread(botId);
    const insert = (seq: number, clientNonce: string): Promise<unknown> =>
      db().query(
        "insert into message (thread_id, seq, role, blocks, client_nonce) values ($1, $2, $3, $4, $5)",
        [threadId, seq, "assistant", "[]", clientNonce],
      );

    await insert(1, randomUUID());
    await expect(insert(1, randomUUID())).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses a reused event position", async () => {
    const runId = await createRun();
    const { rows } = await db().query<{ thread_id: string; space_id: string }>(
      "select thread_id, space_id from run where id = $1",
      [runId],
    );
    const run = rows[0];

    if (run === undefined) {
      throw new Error("the run fixture did not return its thread");
    }

    const insert = (seq: number): Promise<unknown> =>
      db().query(
        "insert into event (space_id, thread_id, seq, type, payload, run_id) values ($1, $2, $3, $4, $5, $6)",
        [run.space_id, run.thread_id, seq, "run.started", "{}", runId],
      );

    await insert(1);
    await expect(insert(1)).rejects.toMatchObject({ code: "23505" });
  });
});

describe("identity foreign keys", () => {
  it("cascades a space delete through bots, threads, tasks and runs", async () => {
    const doomedSpace = randomUUID();
    const doomedUser = randomUUID();
    await db().query("insert into space (id, name) values ($1, $2)", [doomedSpace, "doomed"]);
    await db().query('insert into "user" (id, name, email) values ($1, $2, $3)', [
      doomedUser,
      "doomed user",
      `doomed-${doomedUser}@example.test`,
    ]);

    const botId = await createBot({ spaceId: doomedSpace, userId: doomedUser });
    const threadId = await createThread(botId, doomedSpace);
    const taskId = await createTask(botId, threadId, doomedSpace);
    const { rows } = await db().query<{ id: string }>(
      "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
        "values ($1, $2, $3, $4, $5, 'queued', 'message', $6) returning id",
      [doomedSpace, botId, threadId, taskId, doomedUser, randomUUID()],
    );
    const runId = requiredId(rows[0], "a doomed run");

    await db().query(
      "insert into event (space_id, thread_id, seq, type, payload, run_id) values ($1, $2, 1, 'run.started', '{}', $3)",
      [doomedSpace, threadId, runId],
    );

    await db().query("delete from space where id = $1", [doomedSpace]);

    const { rows: remaining } = await db().query<{ runs: number; events: number; bots: number }>(
      "select (select count(*)::int from run where id = $1) as runs, " +
        "(select count(*)::int from event where run_id = $1) as events, " +
        "(select count(*)::int from bot where id = $2) as bots",
      [runId, botId],
    );

    expect(remaining[0]).toEqual({ runs: 0, events: 0, bots: 0 });
  });

  it("clears an optional link instead of deleting the row", async () => {
    const botId = await createBot();
    const { rows } = await db().query<{ id: string }>(
      "insert into bot_section (space_id, user_id, name) values ($1, $2, $3) returning id",
      [space, user, "a section"],
    );
    const sectionId = requiredId(rows[0], "a section");

    await db().query("update bot set section_id = $1 where id = $2", [sectionId, botId]);
    await db().query("delete from bot_section where id = $1", [sectionId]);

    const { rows: after } = await db().query<{ section_id: string | null }>(
      "select section_id from bot where id = $1",
      [botId],
    );

    expect(after[0]?.section_id).toBeNull();
  });
});
