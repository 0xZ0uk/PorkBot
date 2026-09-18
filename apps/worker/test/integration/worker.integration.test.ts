import { randomUUID } from "node:crypto";
import { workerRole } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { connectToSuite, connectionStringForRole, createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteClient, SuiteDatabase } from "@porkbot/testkit";
import type { Runner } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExecuteIdentifier } from "../../src/jobs/run-execute.ts";
import type { RunExecution } from "../../src/jobs/run-execute.ts";
import { startWorker } from "../../src/worker.ts";

/**
 * The worker against the real database: Graphile's runner, the worker's own
 * role, and the run-execute job delivering through the queue.
 *
 * The suite proves the parts only a real server can:
 *
 *   - the worker role can install and use `graphile_worker` (the schema is
 *     granted to it by the roles migration) while reading the domain rows a
 *     job re-reads;
 *   - a fence-matched delivery reaches the executor once;
 *   - a duplicate delivery after the row's fence moved is a no-op, because the
 *     handler's decision is the row, not the delivery count (PRD decision 17);
 *   - a job whose fence never matched, and a job whose payload names another
 *     space, both complete without the executor ever being called — the queue's
 *     answer and the row fence's answer are both authoritative.
 *
 * The executor here records the call after the production claim has moved the
 * fence, so the second delivery meets a row whose owner changed.
 */

const suiteName = "worker_jobs";

let suite: SuiteDatabase | undefined;
let administrator: SuiteClient | undefined;
let runner: Runner | undefined;
const executions: RunExecution[] = [];

let spaceId = "";
let otherSpaceId = "";
let runId = "";

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: suiteName });
  administrator = await connectToSuite(suite);

  spaceId = await insertSpace("worker suite");
  otherSpaceId = await insertSpace("another space");
  const userId = await insertUser();
  const botId = await insertBot(spaceId, userId);
  const threadId = await insertThread(spaceId, botId, userId);
  const taskId = await insertTask(spaceId, botId, threadId, userId);
  runId = await insertRun(spaceId, botId, threadId, taskId, userId);

  runner = await startWorker({
    connectionString: connectionStringForRole(suite.connectionString, workerRole),
    scheduleWatchdog: false,
    executeRun: async (execution) => {
      executions.push(execution);
    },
    logger: createLogger({ service: "@porkbot/worker", write: () => {} }),
    pollInterval: 100,
  });
}, 180_000);

afterAll(async () => {
  await runner?.stop("the suite is done");
  await administrator?.end();
  await suite?.destroy();
});

function db(): SuiteClient {
  if (administrator === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return administrator;
}

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;

  for (;;) {
    if (await predicate()) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Adds a job through the runner's own connection and waits for it to finish. */
async function deliver(payload: { runId: string; fence: number; spaceId: string }): Promise<void> {
  if (runner === undefined) {
    throw new Error("the runner was not started; the beforeAll hook failed first");
  }

  const job = await runner.addJob(runExecuteIdentifier, payload);

  await waitFor(async () => {
    const { rows } = await db().query<{ count: number }>(
      "select count(*)::int as count from graphile_worker.jobs where id = $1",
      [job.id],
    );

    return rows[0]?.count === 0;
  }, `job ${job.id} to be handled`);
}

async function insertSpace(name: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into space (name) values ($1) returning id::text as id",
    [name],
  );

  return required(rows[0]?.id);
}

async function insertUser(): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    ["Worker Suite", `${randomUUID()}@example.test`],
  );

  return required(rows[0]?.id);
}

async function insertBot(space: string, user: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into bot (space_id, user_id, name, color, spawn_key) " +
      "values ($1, $2, 'Probe', '#4f46e5', $3) returning id::text as id",
    [space, user, randomUUID()],
  );

  return required(rows[0]?.id);
}

async function insertThread(space: string, bot: string, user: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into thread (space_id, bot_id, user_id) values ($1, $2, $3) returning id::text as id",
    [space, bot, user],
  );

  return required(rows[0]?.id);
}

async function insertTask(
  space: string,
  bot: string,
  thread: string,
  user: string,
): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
      "values ($1, $2, $3, $4, 'probe', 'queued') returning id::text as id",
    [space, bot, thread, user],
  );

  return required(rows[0]?.id);
}

async function insertRun(
  space: string,
  bot: string,
  thread: string,
  task: string,
  user: string,
): Promise<string> {
  const { rows } = await db().query<{ id: string; lease_fence: number }>(
    "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
      "values ($1, $2, $3, $4, $5, 'queued', 'message', $6) " +
      "returning id::text as id, lease_fence",
    [space, bot, thread, task, user, randomUUID()],
  );

  expect(rows[0]?.lease_fence).toBe(0);

  return required(rows[0]?.id);
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("the fixture insert returned no id");
  }

  return value;
}

describe("the worker's run-execute job", () => {
  it("runs a fence-matched job once and treats a duplicate delivery as a no-op", async () => {
    await deliver({ runId, fence: 0, spaceId });

    expect(executions).toHaveLength(1);
    expect(executions[0]?.run.id).toBe(runId);
    expect(executions[0]?.run.leaseFence).toBe(1);

    // The first delivery claimed the row. The queue still has no idea; it is
    // the handler's re-read that decides.
    await deliver({ runId, fence: 0, spaceId });

    expect(executions).toHaveLength(1);

    const { rows } = await db().query<{ lease_fence: number }>(
      "select lease_fence from run where id = $1",
      [runId],
    );

    expect(rows[0]?.lease_fence).toBe(1);
  });

  it("exits without side effects when the payload's fence never matched", async () => {
    const before = await runFence();

    await deliver({ runId, fence: 99, spaceId });

    expect(executions).toHaveLength(1);
    expect(await runFence()).toBe(before);
  });

  it("is not-found, not an error, when the payload names another space", async () => {
    const before = await runFence();

    await deliver({ runId, fence: 1, spaceId: otherSpaceId });

    expect(executions).toHaveLength(1);
    expect(await runFence()).toBe(before);
  });

  it("completes a job for a run that does not exist", async () => {
    const before = await runFence();

    await deliver({ runId: randomUUID(), fence: 0, spaceId });

    expect(executions).toHaveLength(1);
    expect(await runFence()).toBe(before);
  });
});

async function runFence(): Promise<number> {
  const { rows } = await db().query<{ lease_fence: number }>(
    "select lease_fence from run where id = $1",
    [runId],
  );

  return required(rows[0]?.lease_fence);
}
