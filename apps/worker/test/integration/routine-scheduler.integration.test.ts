import { randomUUID } from "node:crypto";
import { workerRole } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { connectToSuite, connectionStringForRole, createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteClient, SuiteDatabase } from "@porkbot/testkit";
import type { Runner } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunExecution } from "../../src/jobs/run-execute.ts";
import { routineTickIdentifier } from "../../src/jobs/routine-schedule.ts";
import { startWorker } from "../../src/worker.ts";

/**
 * The routine scheduler against a real database and a real queue: the tick
 * delivered through Graphile, a due slot fired through the worker role's new
 * grants, the run picked up by the ordinary `run.execute` handler and the
 * existing executor, and a slot beyond the grace recorded missed without a
 * run.
 *
 * This is the suite that proves "scheduled runs execute under the same
 * lease/fence path as interactive runs": there is no second executor here,
 * only the `executeRun` seam the whole worker already uses.
 */

const suiteName = "worker_routines";

let suite: SuiteDatabase | undefined;
let administrator: SuiteClient | undefined;
let runner: Runner | undefined;
const executions: RunExecution[] = [];

let spaceId = "";
let userId = "";
let botId = "";

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: suiteName });
  administrator = await connectToSuite(suite);

  spaceId = await insertSpace("routine worker suite");
  userId = await insertUser();
  botId = await insertBot(spaceId, userId);

  runner = await startWorker({
    connectionString: connectionStringForRole(suite.connectionString, workerRole),
    scheduleWatchdog: false,
    scheduleRoutines: false,
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
    ["Routine Suite", `${randomUUID()}@example.test`],
  );

  return required(rows[0]?.id);
}

async function insertBot(space: string, user: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into bot (space_id, user_id, name, color, spawn_key) " +
      "values ($1, $2, 'Routine Probe', '#4f46e5', $3) returning id::text as id",
    [space, user, randomUUID()],
  );

  return required(rows[0]?.id);
}

/** Creates the routine the way the product does: the thread comes with it. */
async function insertRoutine(instruction: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into thread (space_id, bot_id, user_id) values ($1, $2, $3) returning id::text as id",
    [spaceId, botId, userId],
  );
  const threadId = required(rows[0]?.id);

  const { rows: routineRows } = await db().query<{ id: string }>(
    "insert into routine (space_id, bot_id, user_id, thread_id, instruction, cron, timezone, " +
      "enabled, next_run_at) values ($1, $2, $3, $4, $5, '* * * * *', 'UTC', true, now()) " +
      "returning id::text as id",
    [spaceId, botId, userId, threadId, instruction],
  );

  return required(routineRows[0]?.id);
}

async function backdate(routineId: string, seconds: number): Promise<void> {
  await db().query(
    "update routine set next_run_at = now() - make_interval(secs => $2) where id = $1",
    [routineId, seconds],
  );
}

/** Adds a tick through the runner and waits for the queue to finish it. */
async function tick(): Promise<void> {
  if (runner === undefined) {
    throw new Error("the runner was not started; the beforeAll hook failed first");
  }

  const job = await runner.addJob(routineTickIdentifier, {});

  await waitFor(async () => {
    const { rows } = await db().query<{ count: number }>(
      "select count(*)::int as count from graphile_worker.jobs where id = $1",
      [job.id],
    );

    return rows[0]?.count === 0;
  }, `tick ${job.id} to be handled`);
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("the fixture insert returned no id");
  }

  return value;
}

describe("the routine scheduler job", () => {
  it("fires a due slot into a run that the ordinary executor picks up", async () => {
    const routineId = await insertRoutine("worker fire");
    await backdate(routineId, 1);

    await tick();

    await waitFor(
      async () => executions.some((execution) => execution.run.trigger === "routine"),
      "the scheduled run to execute",
    );

    const execution = executions.find((candidate) => candidate.run.trigger === "routine");
    expect(execution?.run.trigger).toBe("routine");
    expect(execution?.run.leaseFence).toBe(1);
    expect(execution?.resumed).toBe(false);
    expect(execution?.run.botId).toBe(botId);

    const { rows } = await db().query<{ run_id: string | null; status: string }>(
      "select occurrence.run_id, run.status::text as status " +
        "from routine_occurrence occurrence join run on run.id = occurrence.run_id " +
        "where occurrence.routine_id = $1",
      [routineId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.run_id).toBe(execution?.run.id);
    expect(rows[0]?.status).toBe("running");
  });

  it("records a slot beyond the grace as missed and runs nothing", async () => {
    const routineId = await insertRoutine("worker miss");
    await backdate(routineId, 10 * 60);

    await tick();

    const { rows } = await db().query<{ run_id: string | null }>(
      "select run_id from routine_occurrence where routine_id = $1",
      [routineId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.run_id).toBeNull();

    const { rows: advanced } = await db().query<{ future: boolean }>(
      "select next_run_at > now() as future from routine where id = $1",
      [routineId],
    );
    expect(advanced[0]?.future).toBe(true);

    // The missed slot produced no run at all, so nothing could have executed.
    const { rows: runs } = await db().query<{ count: number }>(
      "select count(*)::int as count from run r " +
        "join routine routine on routine.thread_id = r.thread_id where routine.id = $1",
      [routineId],
    );
    expect(runs[0]?.count).toBe(0);
  });

  it("leaves a disabled routine alone even when its stored cursor is due", async () => {
    const routineId = await insertRoutine("worker disabled");
    await backdate(routineId, 1);
    await db().query("update routine set enabled = false where id = $1", [routineId]);

    await tick();

    const { rows } = await db().query<{ count: number }>(
      "select count(*)::int as count from routine_occurrence where routine_id = $1",
      [routineId],
    );
    expect(rows[0]?.count).toBe(0);
  });
});
