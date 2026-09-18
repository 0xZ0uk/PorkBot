import { randomUUID } from "node:crypto";
import { UnreachableRoutineSchedule } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";
import { findQueuedRoutineRuns, listDueRoutines } from "../../src/routines.ts";

/**
 * The routine rows against a real server: the scheduler's scan, the fire and
 * miss transactions, the occurrence ledger's idempotency under a race, the
 * outcome mapping, and the disable/delete rules the issue states. The unit
 * suite proves the store's branch shapes with a fake; this suite proves the
 * SQL, the partial index's predicate, the row lock and the unique key.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;
let user: UserActor;
let otherUser: UserActor;
let botId: string;

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

function system(spaceId: string, jobId: string): SystemActor {
  return { kind: "system", spaceId, jobId };
}

async function createActor(spaceName: string): Promise<UserActor> {
  const { rows: spaceRows } = await db().query<{ id: string }>(
    "insert into space (name) values ($1) returning id",
    [spaceName],
  );
  const { rows: userRows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id',
    ["routine fixture", `${randomUUID()}@example.test`],
  );
  const spaceId = required(spaceRows[0]?.id);
  const userId = required(userRows[0]?.id);
  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, 'owner')", [
    spaceId,
    userId,
  ]);

  return { kind: "user", spaceId, userId, role: "owner" };
}

async function createBot(actor: UserActor, name: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into bot (space_id, user_id, name, color, spawn_key) values ($1, $2, $3, $4, $5) " +
      "returning id",
    [actor.spaceId, actor.userId, name, "fixture-color", randomUUID()],
  );

  return required(rows[0]?.id);
}

/** Puts a routine's cursor in the past without going through the store. */
async function backdate(routineId: string, seconds: number): Promise<Date> {
  const { rows } = await db().query<{ scheduled: Date }>(
    "update routine set next_run_at = now() - make_interval(secs => $2) " +
      "where id = $1 returning next_run_at as scheduled",
    [routineId, seconds],
  );

  return new Date(required(rows[0]?.scheduled));
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("the fixture query returned no row");
  }

  return value;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_routines" });
  client = await connect();
  user = await createActor("routines");
  otherUser = await createActor("routines other");
  botId = await createBot(user, "Routine bot");
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

describe("a created routine", () => {
  it("gets a dedicated thread and a next fire in its own timezone", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "summarise the inbox",
      cron: "30 9 * * *",
      timezone: "America/New_York",
    });

    expect(routine.enabled).toBe(true);
    expect(routine.threadId).not.toBeNull();
    expect(routine.nextRunAt.getTime()).toBeGreaterThan(Date.now());

    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).format(routine.nextRunAt);
    expect(local).toBe("09:30");

    const { rows: threadRows } = await db().query<{ count: number }>(
      "select count(*)::int as count from thread where id = $1 and bot_id = $2 and space_id = $3",
      [routine.threadId, botId, user.spaceId],
    );
    expect(threadRows[0]?.count).toBe(1);
  });

  it("is visible to its space and invisible to another", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "visibility",
      cron: "0 * * * *",
      timezone: "UTC",
    });

    const mine = await store.list();
    expect(mine.map((row) => row.id)).toContain(routine.id);

    const other = createRepositories(otherUser, db()).routines;
    const theirs = await other.list();
    expect(theirs.map((row) => row.id)).not.toContain(routine.id);
    await expect(other.findById(routine.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a schedule that can never fire instead of inserting a dead row", async () => {
    const store = createRepositories(user, db()).routines;

    // February 31 exists in the grammar but never on the calendar, and the
    // store computes the first fire before the insert, so no row is created.
    await expect(
      store.create({
        botId,
        instruction: "unreachable",
        cron: "0 0 31 2 *",
        timezone: "UTC",
      }),
    ).rejects.toBeInstanceOf(UnreachableRoutineSchedule);

    const { rows } = await db().query<{ count: number }>(
      "select count(*)::int as count from routine where instruction = 'unreachable'",
    );
    expect(rows[0]?.count).toBe(0);
  });
});

describe("the scheduler's fire path", () => {
  it("scans a due routine, creates an ordinary run, and writes it down once", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "fire me",
      cron: "* * * * *",
      timezone: "UTC",
    });
    const scheduledFor = await backdate(routine.id, 1);

    const due = await listDueRoutines(db(), 100);
    const candidate = due.find((row) => row.id === routine.id);
    expect(candidate).toBeDefined();
    expect(candidate?.now.getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);

    const scheduler = createRepositories(system(routine.spaceId, "tick-1"), db()).routines;
    const fired = await scheduler.fire({
      routineId: routine.id,
      scheduledFor: required(candidate?.nextRunAt),
      nextRunAt: new Date(scheduledFor.getTime() + 60_000),
    });

    expect(fired).toBeDefined();
    const run = required(fired?.run);
    expect(run).toMatchObject({
      status: "queued",
      trigger: "routine",
      threadId: routine.threadId,
      sourceMessageId: null,
      leaseFence: 0,
      leaseOwner: null,
    });
    expect(run.clientNonce).toBe(`routine:${routine.id}:${scheduledFor.getTime()}`);

    const { rows: taskRows } = await db().query<{ prompt: string; status: string }>(
      "select prompt, status::text as status from task where id = $1",
      [run.taskId],
    );
    expect(taskRows[0]).toEqual({ prompt: "fire me", status: "queued" });

    const { rows: occurrenceRows } = await db().query<{ run_id: string }>(
      "select run_id from routine_occurrence where routine_id = $1 and scheduled_for = $2",
      [routine.id, scheduledFor],
    );
    expect(occurrenceRows[0]?.run_id).toBe(run.id);

    const advanced = await store.findById(routine.id);
    expect(advanced.nextRunAt.getTime()).toBe(scheduledFor.getTime() + 60_000);

    // The same slot again is a no-op: the ledger's unique key answers it, and
    // no second task or run exists.
    const duplicate = await scheduler.fire({
      routineId: routine.id,
      scheduledFor,
      nextRunAt: new Date(scheduledFor.getTime() + 60_000),
    });
    expect(duplicate).toBeUndefined();

    const { rows: counts } = await db().query<{ runs: number; tasks: number }>(
      "select (select count(*)::int from run where task_id = $1) as runs, " +
        "(select count(*)::int from task where id = $1) as tasks",
      [run.taskId],
    );
    expect(counts[0]).toEqual({ runs: 1, tasks: 1 });
  });

  it("gives exactly one winner to two schedulers racing one slot", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "race me",
      cron: "* * * * *",
      timezone: "UTC",
    });
    const scheduledFor = await backdate(routine.id, 1);
    const contenders = await Promise.all([connect(), connect()]);

    try {
      const [first, second] = contenders;
      if (first === undefined || second === undefined) {
        throw new Error("expected two contenders");
      }

      const results = await Promise.all([
        createRepositories(system(routine.spaceId, "tick-a"), first).routines.fire({
          routineId: routine.id,
          scheduledFor,
          nextRunAt: new Date(scheduledFor.getTime() + 60_000),
        }),
        createRepositories(system(routine.spaceId, "tick-b"), second).routines.fire({
          routineId: routine.id,
          scheduledFor,
          nextRunAt: new Date(scheduledFor.getTime() + 60_000),
        }),
      ]);

      expect(results.filter((result) => result !== undefined)).toHaveLength(1);

      const { rows } = await db().query<{ count: number }>(
        "select count(*)::int as count from run where thread_id = $1 and trigger = 'routine'",
        [routine.threadId],
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await Promise.all(contenders.map((contender) => contender.end()));
    }
  });

  it("refuses a fire addressed through another space", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "not yours",
      cron: "* * * * *",
      timezone: "UTC",
    });
    const scheduledFor = await backdate(routine.id, 1);

    const foreign = createRepositories(system(otherUser.spaceId, "tick-x"), db()).routines;
    const fired = await foreign.fire({
      routineId: routine.id,
      scheduledFor,
      nextRunAt: new Date(scheduledFor.getTime() + 60_000),
    });

    expect(fired).toBeUndefined();
    const { rows } = await db().query<{ count: number }>(
      "select count(*)::int as count from run where thread_id = $1",
      [routine.threadId],
    );
    expect(rows[0]?.count).toBe(0);
  });
});

describe("the scheduler's miss path and the outcome history", () => {
  it("records a missed slot with no run, and reports success, failure and missed alike", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "history",
      cron: "* * * * *",
      timezone: "UTC",
    });
    const scheduler = createRepositories(system(routine.spaceId, "tick-2"), db()).routines;
    const first = await backdate(routine.id, 1);

    const missed = await scheduler.recordMissed({
      routineId: routine.id,
      scheduledFor: first,
      nextRunAt: new Date(first.getTime() + 60_000),
    });
    expect(missed?.runId).toBeNull();

    const second = required((await store.findById(routine.id)).nextRunAt);
    const fired = required(
      await scheduler.fire({
        routineId: routine.id,
        scheduledFor: second,
        nextRunAt: new Date(second.getTime() + 60_000),
      }),
    );

    // Completed and failed runs are the run state machine's to produce; the
    // ledger's read is what this suite checks, so the rows are moved directly.
    await db().query("update run set status = 'completed', completed_at = now() where id = $1", [
      fired.run.id,
    ]);

    const third = required((await store.findById(routine.id)).nextRunAt);
    const failed = required(
      await scheduler.fire({
        routineId: routine.id,
        scheduledFor: third,
        nextRunAt: new Date(third.getTime() + 60_000),
      }),
    );
    await db().query("update run set status = 'failed', completed_at = now() where id = $1", [
      failed.run.id,
    ]);

    const outcomes = await store.outcomes(routine.id, 10);
    expect(outcomes.map((outcome) => [outcome.status, outcome.runId !== null])).toEqual([
      ["failure", true],
      ["success", true],
      ["missed", false],
    ]);
    expect(outcomes[0]?.scheduledFor.getTime()).toBe(third.getTime());
    expect(outcomes[0]?.runId).toBe(failed.run.id);

    const last = await store.lastOutcome(routine.id);
    expect(last?.occurrenceId).toBe(outcomes[0]?.occurrenceId);
  });
});

describe("disabling and deleting a routine", () => {
  it("stops future runs on pause and resumes the cursor on enable", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "pause me",
      cron: "* * * * *",
      timezone: "UTC",
    });

    await backdate(routine.id, 1);
    await store.update(routine.id, { enabled: false });

    const due = await listDueRoutines(db(), 100);
    expect(due.map((row) => row.id)).not.toContain(routine.id);

    // A scheduler that still holds the stale candidate cannot fire it either:
    // the fire's locked re-read filters the disabled row.
    const scheduler = createRepositories(system(routine.spaceId, "tick-3"), db()).routines;
    const stale = await scheduler.fire({
      routineId: routine.id,
      scheduledFor: routine.nextRunAt,
      nextRunAt: new Date(routine.nextRunAt.getTime() + 60_000),
    });
    expect(stale).toBeUndefined();

    const reenabled = await store.update(routine.id, { enabled: true });
    expect(reenabled.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("tombstones without deleting the thread, the runs or the ledger", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "delete me",
      cron: "* * * * *",
      timezone: "UTC",
    });
    const scheduledFor = await backdate(routine.id, 1);
    const scheduler = createRepositories(system(routine.spaceId, "tick-4"), db()).routines;
    const fired = required(
      await scheduler.fire({
        routineId: routine.id,
        scheduledFor,
        nextRunAt: new Date(scheduledFor.getTime() + 60_000),
      }),
    );

    const removed = await store.remove(routine.id);
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.enabled).toBe(false);

    await expect(store.findById(routine.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await store.list()).map((row) => row.id)).not.toContain(routine.id);

    const due = await listDueRoutines(db(), 100);
    expect(due.map((row) => row.id)).not.toContain(routine.id);

    const { rows: surviving } = await db().query<{
      threads: number;
      runs: number;
      occurrences: number;
    }>(
      "select (select count(*)::int from thread where id = $1) as threads, " +
        "(select count(*)::int from run where id = $2) as runs, " +
        "(select count(*)::int from routine_occurrence where routine_id = $3) as occurrences",
      [routine.threadId, fired.run.id, routine.id],
    );
    expect(surviving[0]).toEqual({ threads: 1, runs: 1, occurrences: 1 });
  });

  it("re-addresses only routine runs that sat unclaimed past the grace", async () => {
    const store = createRepositories(user, db()).routines;
    const routine = await store.create({
      botId,
      instruction: "stranded",
      cron: "* * * * *",
      timezone: "UTC",
    });
    const scheduledFor = await backdate(routine.id, 1);
    const scheduler = createRepositories(system(routine.spaceId, "tick-5"), db()).routines;
    const fired = required(
      await scheduler.fire({
        routineId: routine.id,
        scheduledFor,
        nextRunAt: new Date(scheduledFor.getTime() + 60_000),
      }),
    );

    const immediate = await findQueuedRoutineRuns(db(), 100);
    expect(immediate.map((row) => row.runId)).not.toContain(fired.run.id);

    const pastGrace = await findQueuedRoutineRuns(db(), 100, 0);
    expect(pastGrace).toContainEqual({
      runId: fired.run.id,
      spaceId: routine.spaceId,
      fence: 0,
    });
  });
});
