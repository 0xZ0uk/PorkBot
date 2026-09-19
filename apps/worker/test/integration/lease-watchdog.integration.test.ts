import { randomUUID } from "node:crypto";
import { NotificationEmulator } from "@porkbot/adapters";
import { createExternalEffectLedger, workerRole } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { connectToSuite, connectionStringForRole, createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteClient, SuiteDatabase } from "@porkbot/testkit";
import type { Runner } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leaseWatchdogIdentifier } from "../../src/jobs/lease-watchdog.ts";
import type { RunExecution } from "../../src/jobs/run-execute.ts";
import { startWorker } from "../../src/worker.ts";

/**
 * The fence-loss recovery path against the real database and the real queue: a
 * worker dies mid-run, its lease expires, the watchdog reclaims and hands the
 * run to another delivery, and the run finishes from its checkpoint.
 *
 * These are the facts only a server and a runner can answer:
 *
 *   - the watchdog's global scan finds expired leases across spaces while every
 *     write it makes stays scoped to the row's space;
 *   - a reclaim closes the dead attempt with the reason and records no attempt
 *     of its own, so the resume's attempt count is honest;
 *   - the reclaim of a run with a checkpoint is handed off and adopted by the
 *     next delivery, which sees `resumed: true` and the stored checkpoint;
 *   - a run with no checkpoint is failed with the typed reason instead of
 *     restarting from scratch;
 *   - the kill-resume leaves exactly one completed attempt and never re-runs
 *     the abandoned fence.
 */

let suite: SuiteDatabase | undefined;
let administrator: SuiteClient | undefined;
let runner: Runner | undefined;

let spaceId = "";
let otherSpaceId = "";
let userId = "";
const executions: RunExecution[] = [];
const behaviors = new Map<string, (execution: RunExecution) => Promise<void>>();
const notifications = new NotificationEmulator();

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "worker_watchdog" });
  administrator = await connectToSuite(suite);

  spaceId = await insertSpace("watchdog suite");
  otherSpaceId = await insertSpace("watchdog suite B");
  userId = await insertUser();

  runner = await startWorker({
    connectionString: connectionStringForRole(suite.connectionString, workerRole),
    scheduleWatchdog: false,
    scheduleRoutines: false,
    executeRun: async (execution) => {
      executions.push(execution);
      const behavior = behaviors.get(execution.run.id);

      if (behavior !== undefined) {
        await behavior(execution);
      }
    },
    stallNotification: {
      provider: notifications,
      origin: "https://porkbot.example.invalid",
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

async function deliver(identifier: string, payload: Record<string, unknown>): Promise<void> {
  if (runner === undefined) {
    throw new Error("the runner was not started; the beforeAll hook failed first");
  }

  const job = await runner.addJob(identifier, payload);

  await waitFor(async () => {
    const { rows } = await db().query<{ count: number }>(
      "select count(*)::int as count from graphile_worker.jobs where id = $1",
      [job.id],
    );

    return rows[0]?.count === 0;
  }, `job ${job.id} (${identifier}) to be handled`);
}

async function runRow(runId: string): Promise<{
  readonly status: string;
  readonly leaseFence: number;
  readonly leaseOwner: string | null;
  readonly errorCode: string | null;
  readonly checkpoint: Record<string, unknown>;
}> {
  const { rows } = await db().query<{
    status: string;
    leaseFence: number;
    leaseOwner: string | null;
    errorCode: string | null;
    checkpoint: Record<string, unknown>;
  }>(
    'select status::text as status, lease_fence as "leaseFence", lease_owner as "leaseOwner", ' +
      'error_code as "errorCode", checkpoint from run where id = $1',
    [runId],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`run ${runId} does not exist`);
  }

  return row;
}

async function attemptsFor(runId: string): Promise<
  ReadonlyArray<{
    readonly fence: number;
    readonly status: string;
    readonly error: string | null;
  }>
> {
  const { rows } = await db().query<{ fence: number; status: string; error: string | null }>(
    "select fence, status::text as status, error from attempt where run_id = $1 order by fence asc",
    [runId],
  );

  return rows;
}

async function expireLease(runId: string): Promise<void> {
  await db().query("update run set lease_expires_at = now() - interval '1 second' where id = $1", [
    runId,
  ]);
}

async function insertSpace(name: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into space (name) values ($1) returning id::text as id",
    [name],
  );

  return required(rows[0]?.id, "a space");
}

async function insertUser(): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    ["Watchdog Suite", `${randomUUID()}@example.test`],
  );

  return required(rows[0]?.id, "a user");
}

async function insertRun(space: string, name: string): Promise<string> {
  const bot = await db().query<{ id: string }>(
    "insert into bot (space_id, user_id, name, color, spawn_key) " +
      "values ($1, $2, $3, '#4f46e5', $4) returning id::text as id",
    [space, userId, `Bot ${name}`, randomUUID()],
  );
  const botId = required(bot.rows[0]?.id, "a bot");
  const thread = await db().query<{ id: string }>(
    "insert into thread (space_id, bot_id, user_id) values ($1, $2, $3) returning id::text as id",
    [space, botId, userId],
  );
  const threadId = required(thread.rows[0]?.id, "a thread");
  const task = await db().query<{ id: string }>(
    "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
      "values ($1, $2, $3, $4, 'probe', 'queued') returning id::text as id",
    [space, botId, threadId, userId],
  );
  const taskId = required(task.rows[0]?.id, "a task");
  const run = await db().query<{ id: string }>(
    "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
      "values ($1, $2, $3, $4, $5, 'queued', 'message', $6) returning id::text as id",
    [space, botId, threadId, taskId, userId, randomUUID()],
  );

  return required(run.rows[0]?.id, "a run");
}

function required<Value>(value: Value | undefined, what: string): Value {
  if (value === undefined) {
    throw new Error(`expected ${what} to insert and return its id`);
  }

  return value;
}

async function threadOf(runId: string): Promise<string> {
  const { rows } = await db().query<{ threadId: string }>(
    'select thread_id::text as "threadId" from run where id = $1',
    [runId],
  );

  return required(rows[0]?.threadId, "the run's thread");
}

describe("the lease watchdog", () => {
  it("boots a runner with the minute schedule registered", async () => {
    // The schedule is parsed by Graphile while `run` boots, so a schedule the
    // runner refuses fails here rather than in a deployment. It is this suite's
    // first test so the short-lived runner never sees an expired fixture.
    if (suite === undefined) {
      throw new Error("the suite's database was not created; the beforeAll hook failed first");
    }

    const probe = await startWorker({
      connectionString: connectionStringForRole(suite.connectionString, workerRole),
      executeRun: async () => undefined,
      logger: createLogger({ service: "@porkbot/worker", write: () => {} }),
      pollInterval: 100,
    });

    try {
      expect(typeof probe.stop).toBe("function");
    } finally {
      await probe.stop("the schedule probe is done");
    }
  });

  it("recovers a killed worker's run from its checkpoint without re-running the dead fence", async () => {
    const runId = await insertRun(spaceId, "resume");
    let sawCheckpoint: unknown;

    behaviors.set(runId, async (execution) => {
      const owner = execution.run.leaseOwner;
      if (owner === null) {
        throw new Error("the executor received an unowned run");
      }

      // The worker gets as far as a checkpoint, then stops heartbeating: the
      // effect of a process that died between two tools.
      await execution.repositories.runs.update(
        runId,
        { owner, fence: execution.run.leaseFence },
        { checkpoint: { step: 1, compacted: "so far" } },
      );
    });

    await deliver("run.execute", { runId, fence: 0, spaceId });
    await waitFor(async () => (await runRow(runId)).checkpoint["step"] === 1, "the checkpoint");
    await expireLease(runId);

    behaviors.set(runId, async (execution) => {
      const owner = execution.run.leaseOwner;
      if (owner === null) {
        throw new Error("the resume received an unowned run");
      }

      sawCheckpoint = execution.run.checkpoint;
      await execution.repositories.runs.update(
        runId,
        { owner, fence: execution.run.leaseFence },
        { status: "completed", completed: true, attempt: "completed" },
      );
    });

    await deliver(leaseWatchdogIdentifier, {});
    await waitFor(async () => (await runRow(runId)).status === "completed", "the resumed run");

    const row = await runRow(runId);
    expect(row.leaseFence).toBe(3);
    expect(row.errorCode).toBeNull();

    const resumes = executions.filter(
      (execution) => execution.run.id === runId && execution.resumed,
    );
    expect(resumes).toHaveLength(1);
    expect(sawCheckpoint).toEqual({ step: 1, compacted: "so far" });

    // Fence 1 (the dead worker) was closed with the reason, fence 2 (the
    // watchdog's handoff) recorded no attempt, and fence 3 (the resume)
    // completed. The dead fence is never re-run.
    const attempts = await attemptsFor(runId);
    expect(attempts.map((attempt) => attempt.fence)).toEqual([1, 3]);
    expect(attempts[0]).toMatchObject({ status: "abandoned" });
    expect(attempts[0]?.error).toContain("lease expired");
    expect(attempts[1]).toMatchObject({ status: "completed", error: null });
  });

  it("fails a reclaimed run with no checkpoint, with the typed reason, in any space", async () => {
    const runId = await insertRun(otherSpaceId, "no-checkpoint");
    behaviors.set(runId, async () => {
      // The worker dies before its first checkpoint.
    });

    await deliver("run.execute", { runId, fence: 0, spaceId: otherSpaceId });
    await waitFor(
      async () => (await runRow(runId)).leaseOwner !== null,
      "the dead worker's claim on the other-space run",
    );
    await expireLease(runId);

    await deliver(leaseWatchdogIdentifier, {});
    await waitFor(
      async () => (await runRow(runId)).status === "failed",
      "the reclaimed run to fail",
    );

    const row = await runRow(runId);
    expect(row.errorCode).toBe("checkpoint_absent");

    const attempts = await attemptsFor(runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 1, status: "abandoned" });
    expect(attempts[0]?.error).toContain("lease expired");
  });

  it("settles a claim the lost owner left in flight, so the resume replays it instead of re-running it", async () => {
    const runId = await insertRun(spaceId, "effects");
    const deadCall = { runId, callId: "call-in-flight", tool: "echo", arguments: {} };
    let replaySeen: string | undefined;

    behaviors.set(runId, async (execution) => {
      const owner = execution.run.leaseOwner;
      if (owner === null) {
        throw new Error("the executor received an unowned run");
      }

      // The dead worker had claimed a tool call just before it stopped.
      const deadLedger = createExternalEffectLedger(
        { kind: "system", spaceId, jobId: "dead-worker" },
        db(),
      );
      await deadLedger.begin(deadCall);

      await execution.repositories.runs.update(
        runId,
        { owner, fence: execution.run.leaseFence },
        { checkpoint: { step: 1 } },
      );
    });

    await deliver("run.execute", { runId, fence: 0, spaceId });
    await waitFor(async () => (await runRow(runId)).checkpoint["step"] === 1, "the checkpoint");
    await expireLease(runId);

    behaviors.set(runId, async (execution) => {
      const owner = execution.run.leaseOwner;
      if (owner === null) {
        throw new Error("the resume received an unowned run");
      }

      // The resume retries the same call id and gets the recorded failure
      // instead of a second side effect, then finishes the run.
      const resumedLedger = createExternalEffectLedger(
        { kind: "system", spaceId, jobId: "resumed-job" },
        db(),
      );
      const admission = await resumedLedger.begin(deadCall);
      replaySeen = admission.status === "failed" ? admission.error : admission.status;

      await execution.repositories.runs.update(
        runId,
        { owner, fence: execution.run.leaseFence },
        { status: "completed", completed: true, attempt: "completed" },
      );
    });

    await deliver(leaseWatchdogIdentifier, {});
    await waitFor(async () => (await runRow(runId)).status === "completed", "the settled run");

    // The reclaim settled the in-flight effect with the reason, so the resume
    // reads a recorded failure rather than an unsatisfiable in-flight claim.
    expect(replaySeen).toContain("lease expired");

    const { rows } = await db().query<{ status: string; result: unknown }>(
      "select status::text as status, result from external_effect where run_id = $1",
      [runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.result).toMatchObject({ error: expect.stringContaining("lease expired") });
  });

  it("finds a live run whose progress stopped and notifies the operator exactly once", async () => {
    const runId = await insertRun(spaceId, "stall");
    await db().query(
      "update run set status = 'running', lease_owner = 'stalled-worker', lease_fence = 1, " +
        "lease_expires_at = now() + interval '60 seconds', last_heartbeat_at = now(), " +
        "last_progress_at = now() - interval '400 seconds', current_step = 'working', " +
        "current_step_tool = 'shell' where id = $1",
      [runId],
    );
    await db().query(
      "insert into space_member (space_id, user_id, role) values ($1, $2, 'owner')",
      [spaceId, userId],
    );
    await db().query(
      "insert into notification_preference (space_id, user_id, kind, enabled) " +
        "values ($1, $2, 'run.stalled', true)",
      [spaceId, userId],
    );

    await deliver(leaseWatchdogIdentifier, {});

    const { rows } = await db().query<{ stalled_at: Date | null }>(
      "select stalled_at from run where id = $1",
      [runId],
    );
    expect(rows[0]?.stalled_at).not.toBeNull();

    const delivered = notifications
      .deliveries()
      .filter((notification) => notification.title === "A run has stalled");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.body).toContain("while running shell");
    expect(delivered[0]?.url).toBe(
      `https://porkbot.example.invalid/threads/${await threadOf(runId)}`,
    );

    // The recorded episode is the exactly-once guard: the next minute's pass
    // sees the same silence and sends nothing.
    await deliver(leaseWatchdogIdentifier, {});
    expect(
      notifications
        .deliveries()
        .filter((notification) => notification.title === "A run has stalled"),
    ).toHaveLength(1);
  });
});
