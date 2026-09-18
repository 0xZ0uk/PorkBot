import { NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import type { RoutineRecord, RunRecord, TaskRecord } from "./records.ts";
import { routineRunNonce, routineTestRunNonce } from "./run-creation.ts";
import { createRoutineStore, findQueuedRoutineRuns, listDueRoutines } from "./routines.ts";

/**
 * The routine store without a server: a recording fake stands in for the pg
 * client, so what these tests prove is the store's own contract — validation
 * happens before any row is touched, the actor's space and user are bound into
 * every statement, the schedule is computed from the database's clock, edits
 * recompute only when they should, and the scheduler's two commands write
 * nothing when the slot was already settled. Whether the SQL is valid and
 * whether two passes really settle one slot is the integration suite's proof.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
}

function fakeDatabase(
  routes: readonly (readonly [RegExp, readonly unknown[]])[] = [],
): FakeDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      calls.push({ text, values });
      const route = routes.find(([pattern]) => pattern.test(text));

      return { rows: (route?.[1] ?? []) as readonly Row[] };
    },
  };
}

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const system = (jobId: string): SystemActor => ({ kind: "system", spaceId: "space-1", jobId });

const clock = new Date("2026-01-01T00:00:00.000Z");

const routine: RoutineRecord = {
  id: "routine-1",
  spaceId: "space-1",
  botId: "bot-1",
  userId: "user-1",
  threadId: "thread-1",
  instruction: "summarise the inbox",
  cron: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  nextRunAt: new Date("2026-01-01T09:00:00.000Z"),
  deletedAt: null,
  createdAt: clock,
  updatedAt: clock,
};

const task: TaskRecord = {
  id: "task-1",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
  userId: "user-1",
  prompt: routine.instruction,
  status: "queued",
  createdAt: clock,
  updatedAt: clock,
};

const run: RunRecord = {
  id: "run-1",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
  taskId: "task-1",
  userId: "user-1",
  status: "queued",
  trigger: "routine",
  error: null,
  errorCode: null,
  leaseOwner: null,
  leaseFence: 0,
  leaseExpiresAt: null,
  checkpoint: {},
  clientNonce: routineRunNonce(routine.id, routine.nextRunAt),
  sourceMessageId: null,
  startedAt: null,
  completedAt: null,
  createdAt: clock,
  updatedAt: clock,
};

const firing = {
  id: routine.id,
  botId: routine.botId,
  threadId: routine.threadId,
  userId: routine.userId,
  instruction: routine.instruction,
};

const occurrence = {
  id: "occurrence-1",
  routineId: routine.id,
  scheduledFor: routine.nextRunAt,
  runId: null,
  createdAt: clock,
  updatedAt: clock,
};

describe("creating a routine", () => {
  it("validates the schedule before touching a row, then creates the thread and the routine", async () => {
    const database = fakeDatabase([
      [/select now\(\) as now/, [{ now: clock }]],
      [/insert into thread/, [{ id: "thread-1" }]],
      [/insert into routine/, [routine]],
    ]);
    const store = createRoutineStore(owner, database);

    const created = await store.create({
      botId: "bot-1",
      instruction: routine.instruction,
      cron: routine.cron,
      timezone: routine.timezone,
    });

    expect(created).toEqual(routine);
    expect(database.calls.map((call) => call.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "begin",
      "select now() as",
      "insert into thread",
      "insert into routine",
      "commit",
    ]);

    const routineInsert = database.calls.find((call) => call.text.includes("insert into routine"));
    expect(routineInsert?.values).toEqual([
      "space-1",
      "bot-1",
      "user-1",
      "thread-1",
      routine.instruction,
      routine.cron,
      routine.timezone,
      new Date("2026-01-01T09:00:00.000Z"),
    ]);
  });

  it("refuses an invalid expression and a timezone the runtime does not know before a row exists", async () => {
    const database = fakeDatabase();
    const store = createRoutineStore(owner, database);

    await expect(
      store.create({ botId: "bot-1", instruction: "x", cron: "not a cron", timezone: "UTC" }),
    ).rejects.toMatchObject({ _tag: "InvalidRoutineScheduleError", reason: "invalid_cron" });
    await expect(
      store.create({ botId: "bot-1", instruction: "x", cron: "0 9 * * *", timezone: "Mars/Base" }),
    ).rejects.toMatchObject({ _tag: "InvalidRoutineScheduleError", reason: "invalid_timezone" });

    expect(database.calls).toEqual([]);
  });

  it("reports a bot outside the actor's space as not-found and writes nothing", async () => {
    const database = fakeDatabase([
      [/select now\(\) as now/, [{ now: clock }]],
      [/insert into thread/, []],
    ]);
    const store = createRoutineStore(owner, database);

    await expect(
      store.create({ botId: "bot-other", instruction: "x", cron: "0 9 * * *", timezone: "UTC" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(database.calls.some((call) => call.text.includes("insert into routine"))).toBe(false);
  });
});

describe("reading routines", () => {
  it("reads one routine inside the actor's space", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
    ]);
    const store = createRoutineStore(owner, database);

    expect(await store.findById(routine.id)).toEqual(routine);
    expect(database.calls[0]?.values).toEqual([routine.id, "space-1"]);
  });

  it("reports a missing routine and one in another space as the same not-found", async () => {
    const store = createRoutineStore(owner, fakeDatabase());

    await expect(store.findById("routine-other")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists the space's live routines, and one bot's with the bot predicate", async () => {
    const database = fakeDatabase([[/from routine where space_id = \$1/, [routine]]]);
    const store = createRoutineStore(owner, database);

    expect(await store.list()).toEqual([routine]);
    expect(await store.listForBot("bot-1")).toEqual([routine]);

    const listCall = database.calls[0];
    expect(listCall?.values).toEqual(["space-1"]);
    expect(listCall?.text).toContain("deleted_at is null");
    expect(database.calls[1]?.values).toEqual(["space-1", "bot-1"]);
    expect(database.calls[1]?.text).toContain("bot_id = $2");
  });

  it("reads outcomes newest first and maps the run's status onto the outcome vocabulary", async () => {
    const outcomes = [
      {
        occurrenceId: "occurrence-2",
        scheduledFor: new Date("2026-01-02T09:00:00.000Z"),
        runId: "run-1",
        status: "success",
      },
      {
        occurrenceId: "occurrence-1",
        scheduledFor: new Date("2026-01-01T09:00:00.000Z"),
        runId: null,
        status: "missed",
      },
    ];
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
      [/from routine_occurrence occurrence/, outcomes],
    ]);
    const store = createRoutineStore(owner, database);

    expect(await store.outcomes(routine.id)).toEqual(outcomes);
    expect(await store.lastOutcome(routine.id)).toEqual(outcomes[0]);

    const outcomeCall = database.calls.find((call) =>
      call.text.includes("from routine_occurrence"),
    );
    expect(outcomeCall?.values).toEqual([routine.id, 20]);
    expect(outcomeCall?.text).toContain("when occurrence.run_id is null then 'missed'");
    expect(outcomeCall?.text).toContain("when run.status = 'completed' then 'success'");
  });

  it("reports outcomes of a routine outside the actor's space as not-found, not as empty", async () => {
    const store = createRoutineStore(owner, fakeDatabase());

    await expect(store.outcomes("routine-other")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("bounds the history request so a caller cannot ask for all of it", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
      [/from routine_occurrence occurrence/, []],
    ]);
    const store = createRoutineStore(owner, database);

    await store.outcomes(routine.id, 10_000);
    await store.outcomes(routine.id, 0);
    await store.outcomes(routine.id, Number.NaN);

    const limits = database.calls
      .filter((call) => call.text.includes("from routine_occurrence"))
      .map((call) => call.values[1]);
    expect(limits).toEqual([200, 1, 20]);
  });

  it("returns no last outcome for a routine that never fired", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
      [/from routine_occurrence occurrence/, []],
    ]);

    expect(await createRoutineStore(owner, database).lastOutcome(routine.id)).toBeUndefined();
  });
});

describe("previewing a schedule", () => {
  it("returns the next fires from the database's clock, strictly increasing", async () => {
    const database = fakeDatabase([[/select now\(\) as now/, [{ now: clock }]]]);
    const store = createRoutineStore(owner, database);

    const fires = await store.preview("0 9 * * *", "UTC", 3);

    expect(fires).toEqual([
      new Date("2026-01-01T09:00:00.000Z"),
      new Date("2026-01-02T09:00:00.000Z"),
      new Date("2026-01-03T09:00:00.000Z"),
    ]);
    expect(database.calls).toEqual([{ text: "select now() as now", values: [] }]);
  });

  it("resolves the wall clock in the submitted timezone", async () => {
    const database = fakeDatabase([[/select now\(\) as now/, [{ now: clock }]]]);
    const store = createRoutineStore(owner, database);

    const fires = await store.preview("30 9 * * *", "America/New_York", 1);

    // 09:30 in New York on New Year's Day is 14:30 UTC (EST).
    expect(fires).toEqual([new Date("2026-01-01T14:30:00.000Z")]);
  });

  it("refuses a bad schedule as the typed invalid-schedule error", async () => {
    const database = fakeDatabase([[/select now\(\) as now/, [{ now: clock }]]]);
    const store = createRoutineStore(owner, database);

    await expect(store.preview("not a cron", "UTC")).rejects.toMatchObject({
      _tag: "InvalidRoutineScheduleError",
      reason: "invalid_cron",
    });
    await expect(store.preview("0 9 * * *", "Mars/Base")).rejects.toMatchObject({
      _tag: "InvalidRoutineScheduleError",
      reason: "invalid_timezone",
    });
    await expect(store.preview("0 0 31 2 *", "UTC")).rejects.toMatchObject({
      _tag: "InvalidRoutineScheduleError",
      reason: "unreachable",
    });

    // The two field-level refusals happen before the clock is read; only the
    // unreachable search needs an instant to search from.
    expect(database.calls).toEqual([{ text: "select now() as now", values: [] }]);
  });

  it("bounds the count so a caller cannot ask for years of fire times", async () => {
    const database = fakeDatabase([[/select now\(\) as now/, [{ now: clock }]]]);
    const store = createRoutineStore(owner, database);

    expect(await store.preview("*/5 * * * *", "UTC")).toHaveLength(5);
    expect(await store.preview("*/5 * * * *", "UTC", 10_000)).toHaveLength(10);
    expect(await store.preview("*/5 * * * *", "UTC", 0)).toHaveLength(1);
    expect(await store.preview("*/5 * * * *", "UTC", Number.NaN)).toHaveLength(5);
  });
});

describe("editing a routine", () => {
  it("edits the instruction without recomputing the schedule", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
      [/^update routine set/, [{ ...routine, instruction: "new instruction" }]],
    ]);
    const store = createRoutineStore(owner, database);

    const updated = await store.update(routine.id, { instruction: "new instruction" });

    expect(updated.instruction).toBe("new instruction");
    expect(database.calls.some((call) => call.text.includes("select now()"))).toBe(false);
    const updateCall = database.calls.find((call) => call.text.startsWith("update routine set"));
    expect(updateCall?.text).toContain("instruction = $1");
    expect(updateCall?.text).not.toContain("next_run_at =");
  });

  it("moves the cursor from the database's clock when the schedule changes", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
      [/select now\(\) as now/, [{ now: clock }]],
      [/^update routine set/, [routine]],
    ]);
    const store = createRoutineStore(owner, database);

    await store.update(routine.id, { cron: "30 9 * * *" });

    const updateCall = database.calls.find((call) => call.text.startsWith("update routine set"));
    expect(updateCall?.values).toContain("30 9 * * *");
    expect(updateCall?.values).toContainEqual(new Date("2026-01-01T09:30:00.000Z"));
    expect(updateCall?.text).toContain("next_run_at = $");
  });

  it("recomputes on a re-enable and leaves the cursor alone on a pause", async () => {
    const paused = { ...routine, enabled: false };
    const enableDatabase = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [paused]],
      [/select now\(\) as now/, [{ now: clock }]],
      [/^update routine set/, [{ ...paused, enabled: true }]],
    ]);

    await createRoutineStore(owner, enableDatabase).update(routine.id, { enabled: true });
    expect(
      enableDatabase.calls.find((call) => call.text.startsWith("update routine set"))?.values,
    ).toContainEqual(new Date("2026-01-01T09:00:00.000Z"));

    const pauseDatabase = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
      [/^update routine set/, [{ ...routine, enabled: false }]],
    ]);

    await createRoutineStore(owner, pauseDatabase).update(routine.id, { enabled: false });
    expect(
      pauseDatabase.calls.find((call) => call.text.startsWith("update routine set"))?.text,
    ).not.toContain("next_run_at =");
  });

  it("keeps the pending slot when an edit submits the same schedule", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
      [/^update routine set/, [routine]],
    ]);
    const store = createRoutineStore(owner, database);

    await store.update(routine.id, { cron: routine.cron, timezone: routine.timezone });

    expect(database.calls.some((call) => call.text.includes("select now()"))).toBe(false);
    expect(
      database.calls.find((call) => call.text.startsWith("update routine set"))?.text,
    ).not.toContain("next_run_at =");
  });

  it("refuses a schedule edit with an invalid expression before writing", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [routine]],
    ]);
    const store = createRoutineStore(owner, database);

    await expect(store.update(routine.id, { cron: "nope nope" })).rejects.toMatchObject({
      _tag: "InvalidRoutineScheduleError",
      reason: "invalid_cron",
    });
    expect(database.calls.some((call) => call.text.includes("select now()"))).toBe(false);
  });

  it("tombstones instead of deleting, so the history stays", async () => {
    const deleted = { ...routine, enabled: false, deletedAt: clock };
    const database = fakeDatabase([[/update routine set enabled = false/, [deleted]]]);
    const store = createRoutineStore(owner, database);

    expect(await store.remove(routine.id)).toEqual(deleted);

    const removeCall = database.calls[0];
    expect(removeCall?.text).toContain("deleted_at = now()");
    expect(removeCall?.values).toEqual([routine.id, "space-1"]);
  });

  it("reports removing a routine that is already gone as not-found", async () => {
    await expect(
      createRoutineStore(owner, fakeDatabase()).remove(routine.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("testing a routine", () => {
  it("fires the routine now without touching the ledger or the cursor", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [firing]],
      [/insert into task/, [task]],
      [/insert into run/, [{ ...run, clientNonce: routineTestRunNonce(routine.id, "nonce-test") }]],
    ]);
    const store = createRoutineStore(owner, database);

    const created = await store.testRun(routine.id, "nonce-test");

    expect(created).toMatchObject({ trigger: "routine", status: "queued" });
    expect(
      database.calls.some((call) => call.text.includes("insert into routine_occurrence")),
    ).toBe(false);
    expect(database.calls.some((call) => call.text.startsWith("update routine"))).toBe(false);
    expect(database.calls.some((call) => call.text.includes("for update"))).toBe(false);
  });
});

describe("the scheduler's halves", () => {
  it("fires a slot by creating the run and the ledger row in one transaction", async () => {
    const database = fakeDatabase([
      [/for update/, [firing]],
      [/insert into routine_occurrence/, [occurrence]],
      [/insert into task/, [task]],
      [/insert into run/, [run]],
      [/update routine_occurrence set run_id/, []],
      [/update routine set next_run_at = \$1, updated_at = now\(\)/, [{ id: routine.id }]],
    ]);
    const store = createRoutineStore(system("job-1"), database);

    const fired = await store.fire({
      routineId: routine.id,
      scheduledFor: routine.nextRunAt,
      nextRunAt: new Date("2026-01-02T09:00:00.000Z"),
    });

    expect(fired).toEqual({ run, occurrenceId: occurrence.id });
    expect(database.calls[0]?.text).toBe("begin");
    expect(database.calls.at(-1)?.text).toBe("commit");

    const lockCall = database.calls.find((call) => call.text.includes("for update"));
    expect(lockCall?.values).toEqual([routine.id, "space-1", routine.nextRunAt]);

    const taskCall = database.calls.find((call) => call.text.includes("insert into task"));
    expect(taskCall?.values).toEqual([
      "space-1",
      "bot-1",
      "thread-1",
      "user-1",
      routine.instruction,
    ]);

    const runCall = database.calls.find((call) => call.text.includes("insert into run"));
    expect(runCall?.values).toEqual([
      "space-1",
      "bot-1",
      "thread-1",
      "task-1",
      "user-1",
      "queued",
      routineRunNonce(routine.id, routine.nextRunAt),
    ]);
    expect(runCall?.text).toContain("'routine'");
    expect(runCall?.text).toContain("$6::run_status");

    const advanceCall = database.calls.find((call) =>
      call.text.startsWith("update routine set next_run_at"),
    );
    expect(advanceCall?.values).toEqual([
      new Date("2026-01-02T09:00:00.000Z"),
      routine.id,
      "space-1",
      routine.nextRunAt,
    ]);
  });

  it("writes nothing when the routine moved, was disabled or was deleted", async () => {
    const store = createRoutineStore(system("job-1"), fakeDatabase([[/for update/, []]]));

    expect(
      await store.fire({
        routineId: routine.id,
        scheduledFor: routine.nextRunAt,
        nextRunAt: new Date("2026-01-02T09:00:00.000Z"),
      }),
    ).toBeUndefined();
  });

  it("rolls back and reports the slot settled when only the run nonce already exists", async () => {
    const database = fakeDatabase([
      [/for update/, [firing]],
      [/insert into routine_occurrence/, [occurrence]],
      [/insert into task/, [task]],
      [/insert into run/, []],
    ]);
    const store = createRoutineStore(system("job-1"), database);

    expect(
      await store.fire({
        routineId: routine.id,
        scheduledFor: routine.nextRunAt,
        nextRunAt: new Date("2026-01-02T09:00:00.000Z"),
      }),
    ).toBeUndefined();

    // The ledger insert must not survive without its run.
    expect(database.calls.at(-1)?.text).toBe("rollback");
  });

  it("writes nothing when the slot already has a ledger row", async () => {
    const database = fakeDatabase([
      [/for update/, [firing]],
      [/insert into routine_occurrence/, []],
    ]);
    const store = createRoutineStore(system("job-1"), database);

    expect(
      await store.fire({
        routineId: routine.id,
        scheduledFor: routine.nextRunAt,
        nextRunAt: new Date("2026-01-02T09:00:00.000Z"),
      }),
    ).toBeUndefined();
    expect(database.calls.some((call) => call.text.includes("insert into task"))).toBe(false);
  });

  it("records a missed slot with no run and advances the cursor", async () => {
    const missed = { ...occurrence };
    const database = fakeDatabase([
      [/for update/, [{ id: routine.id }]],
      [/insert into routine_occurrence/, [missed]],
      [/update routine set next_run_at = \$1, updated_at = now\(\)/, [{ id: routine.id }]],
    ]);
    const store = createRoutineStore(system("job-1"), database);

    const recorded = await store.recordMissed({
      routineId: routine.id,
      scheduledFor: routine.nextRunAt,
      nextRunAt: new Date("2026-01-02T09:00:00.000Z"),
    });

    expect(recorded).toEqual(missed);
    expect(recorded?.runId).toBeNull();
    expect(database.calls.some((call) => call.text.includes("insert into run"))).toBe(false);

    const advanceCall = database.calls.find((call) =>
      call.text.startsWith("update routine set next_run_at"),
    );
    expect(advanceCall?.values).toEqual([
      new Date("2026-01-02T09:00:00.000Z"),
      routine.id,
      "space-1",
      routine.nextRunAt,
    ]);
  });

  it("writes nothing when a missed slot is superseded", async () => {
    const lockLost = createRoutineStore(system("job-1"), fakeDatabase([[/for update/, []]]));

    expect(
      await lockLost.recordMissed({
        routineId: routine.id,
        scheduledFor: routine.nextRunAt,
        nextRunAt: new Date("2026-01-02T09:00:00.000Z"),
      }),
    ).toBeUndefined();

    const settled = createRoutineStore(
      system("job-1"),
      fakeDatabase([
        [/for update/, [{ id: routine.id }]],
        [/insert into routine_occurrence/, []],
      ]),
    );

    expect(
      await settled.recordMissed({
        routineId: routine.id,
        scheduledFor: routine.nextRunAt,
        nextRunAt: new Date("2026-01-02T09:00:00.000Z"),
      }),
    ).toBeUndefined();
  });
});

describe("the scheduler's cross-space scans", () => {
  it("scans due routines with the database's clock carried on each row", async () => {
    const due = [{ ...routine, now: clock }];
    const database = fakeDatabase([[/from routine where enabled/, due]]);

    expect(await listDueRoutines(database, 7)).toEqual(due);
    expect(database.calls[0]?.values).toEqual([7]);
    expect(database.calls[0]?.text).toContain('now() as "now"');
    expect(database.calls[0]?.text).toContain("next_run_at <= now()");
  });

  it("scans only queued, unowned routine runs past the dispatch grace", async () => {
    const queued = [{ runId: "run-1", spaceId: "space-1", fence: 0 }];
    const database = fakeDatabase([[/from run where trigger = 'routine'/, queued]]);

    expect(await findQueuedRoutineRuns(database, 7, 120)).toEqual(queued);
    expect(database.calls[0]?.values).toEqual([7, 120]);
    expect(database.calls[0]?.text).toContain("status = 'queued' and lease_owner is null");
    expect(database.calls[0]?.text).toContain("make_interval(secs => $2)");
  });
});
