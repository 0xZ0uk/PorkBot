import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { INITIAL_RUN_STATUS } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { runColumns } from "./records.ts";
import type { MessageRecord, RunRecord, TaskRecord } from "./records.ts";
import { createRepositories } from "./repositories.ts";
import { createRoutineTestRun, routineTestRunNonce } from "./run-creation.ts";

/**
 * The run-creation command without a server: a recording fake stands in for the
 * pg client, so what these tests prove is the command's own contract — it binds
 * the actor's space and user, it starts the run at the transition map's initial
 * status, it rolls the transaction back when the run conflicts and replays the
 * first result, and it reports an out-of-scope thread as not-found. Whether the
 * statements are valid SQL, and whether two connections submitting the same
 * nonce really produce one run, is the integration suite's proof.
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

const task: TaskRecord = {
  id: "task-1",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
  userId: "user-1",
  prompt: "summarise the inbox",
  status: "queued",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const message: MessageRecord = {
  id: "message-1",
  threadId: "thread-1",
  seq: 0,
  role: "user",
  blocks: [{ type: "text", text: "summarise the inbox" }],
  runId: "run-1",
  clientNonce: "nonce-1",
  createdAt: new Date(0),
};

const run: RunRecord = {
  id: "run-1",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
  taskId: "task-1",
  userId: "user-1",
  status: "queued",
  trigger: "message",
  error: null,
  errorCode: null,
  leaseOwner: null,
  leaseFence: 0,
  leaseExpiresAt: null,
  stopRequestedAt: null,
  checkpoint: {},
  clientNonce: "nonce-1",
  sourceMessageId: "message-1",
  startedAt: null,
  completedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const request = {
  threadId: "thread-1",
  clientNonce: "nonce-1",
  prompt: task.prompt,
  blocks: [{ type: "text", text: task.prompt }] as const,
};

/** The routes a fresh submission takes: the run insert returns the new run. */
const freshRoutes = [
  [/insert into task/, [task]],
  [/insert into run/, [run]],
  [/update thread set next_message_seq/, [{ seq: 0 }]],
  [/insert into message/, [message]],
  [/update run set source_message_id/, [run]],
] as const;

describe("the run-creation command", () => {
  it("builds the message, task and run in one transaction, scoped to the actor", async () => {
    const database = fakeDatabase(freshRoutes);
    const repositories = createRepositories(owner, database);

    const created = await repositories.runs.create(request);

    expect(created).toEqual({ run, task, message });
    expect(database.calls.map((call) => call.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "begin",
      "insert into task",
      "insert into run",
      "update thread set",
      "insert into message",
      "update run set",
      "commit",
    ]);

    const taskCall = database.calls[1];
    expect(taskCall?.values).toEqual(["space-1", "user-1", task.prompt, "thread-1"]);

    const runCall = database.calls[2];
    expect(runCall?.text).toContain("on conflict (space_id, client_nonce) do nothing");
    expect(runCall?.values).toEqual(["space-1", "user-1", INITIAL_RUN_STATUS, "nonce-1", "task-1"]);

    const messageCall = database.calls[4];
    expect(messageCall?.values).toEqual([
      "thread-1",
      0,
      "user",
      JSON.stringify(request.blocks),
      "nonce-1",
      "run-1",
    ]);
  });

  it("starts the run at the transition map's initial status, never a caller's choice", async () => {
    const database = fakeDatabase(freshRoutes);
    const repositories = createRepositories(owner, database);

    await repositories.runs.create(request);

    const runCall = database.calls.find((call) => call.text.startsWith("insert into run"));
    expect(runCall?.values).toContain(INITIAL_RUN_STATUS);
  });

  it("rolls back the task and replays the first result when the nonce already exists", async () => {
    const database = fakeDatabase([
      [/insert into task/, [task]],
      [/insert into run/, []],
      [/select .* from run where space_id/, [run]],
      [/select .* from task where id/, [task]],
      [/select .* from message where id/, [message]],
    ]);
    const repositories = createRepositories(owner, database);

    const created = await repositories.runs.create(request);

    expect(created).toEqual({ run, task, message });
    expect(database.calls.filter((call) => call.text.startsWith("insert into run"))).toHaveLength(
      1,
    );
    expect(database.calls.filter((call) => call.text === "begin")).toHaveLength(1);
    expect(database.calls.filter((call) => call.text === "rollback")).toHaveLength(1);
    expect(database.calls.some((call) => call.text === "commit")).toBe(false);
  });

  it("scopes the replay read to the actor's space as well", async () => {
    const database = fakeDatabase([
      [/insert into task/, [task]],
      [/insert into run/, []],
      [/select .* from run where space_id/, [run]],
      [/select .* from task where id/, [task]],
      [/select .* from message where id/, [message]],
    ]);
    const repositories = createRepositories(
      { kind: "user", spaceId: "space-2", userId: "user-2", role: "member" },
      database,
    );

    await repositories.runs.create(request);

    const replayCall = database.calls.find((call) => call.text.startsWith("select"));
    expect(replayCall?.text).toContain("space_id = $1 and client_nonce = $2");
    expect(replayCall?.values).toEqual(["space-2", "nonce-1"]);
  });

  it("reports an out-of-scope thread as not-found and writes nothing", async () => {
    const database = fakeDatabase();
    const repositories = createRepositories(owner, database);

    const rejected = await repositories.runs
      .create({ ...request, threadId: "thread-9" })
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(NotFoundError);
    expect(rejected).toMatchObject({ resource: "thread", id: "thread-9" });
    expect(database.calls.some((call) => call.text.startsWith("insert into run"))).toBe(false);
    expect(database.calls).toContainEqual({ text: "rollback", values: [] });
    expect(database.calls.some((call) => call.text === "commit")).toBe(false);
  });

  it("refuses to replay a run that has no source message", async () => {
    const database = fakeDatabase([
      [/insert into task/, [task]],
      [/insert into run/, []],
      [/select .* from run where space_id/, [{ ...run, sourceMessageId: null }]],
    ]);
    const repositories = createRepositories(owner, database);

    await expect(repositories.runs.create(request)).rejects.toThrow("without its source message");
  });

  it("reports not-found when the conflict outlived its winner", async () => {
    // A run that conflicted was deleted again before the replay read: there is
    // no first result to return, and nothing was written.
    const database = fakeDatabase([
      [/insert into task/, [task]],
      [/insert into run/, []],
      [/select .* from run where space_id/, []],
    ]);
    const repositories = createRepositories(owner, database);

    await expect(repositories.runs.create(request)).rejects.toMatchObject({
      name: "NotFoundError",
      resource: "thread",
      id: "thread-1",
    });
  });

  it("reports not-found when the thread disappears mid-transaction", async () => {
    const database = fakeDatabase([
      [/insert into task/, [task]],
      [/insert into run/, [run]],
      [/update thread set next_message_seq/, []],
    ]);
    const repositories = createRepositories(owner, database);

    await expect(repositories.runs.create(request)).rejects.toMatchObject({
      name: "NotFoundError",
      resource: "thread",
      id: "thread-1",
    });
    expect(database.calls.filter((call) => call.text === "rollback")).toHaveLength(1);
    expect(database.calls.some((call) => call.text === "commit")).toBe(false);
  });

  it("refuses to replay an incomplete result", async () => {
    const database = fakeDatabase([
      [/insert into task/, [task]],
      [/insert into run/, []],
      [/select .* from run where space_id/, [run]],
      [/select .* from task where id/, []],
    ]);
    const repositories = createRepositories(owner, database);

    await expect(repositories.runs.create(request)).rejects.toThrow(
      'found no task for run "run-1"',
    );
  });
});

/** The routine row a test run reads: the same four fields a fire reads. */
const testRoutine = {
  id: "routine-1",
  botId: "bot-1",
  threadId: "thread-1",
  userId: "user-1",
  instruction: "summarise the inbox",
};

const testRun: RunRecord = {
  ...run,
  id: "run-test",
  trigger: "routine",
  clientNonce: routineTestRunNonce(testRoutine.id, "nonce-test"),
  sourceMessageId: null,
};

const testRequest = { routineId: testRoutine.id, clientNonce: "nonce-test" };

describe("the routine test run", () => {
  it("reads the routine scoped and creates the task and the run in one transaction", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [testRoutine]],
      [/insert into task/, [task]],
      [/insert into run/, [testRun]],
    ]);

    const created = await createRoutineTestRun(owner, database, testRequest);

    expect(created).toEqual(testRun);
    expect(database.calls.map((call) => call.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "begin",
      "select id, bot_id",
      "insert into task",
      "insert into run",
      "commit",
    ]);

    const selectCall = database.calls[1];
    expect(selectCall?.values).toEqual(["routine-1", "space-1"]);

    const taskCall = database.calls[2];
    expect(taskCall?.values).toEqual([
      "space-1",
      "bot-1",
      "thread-1",
      "user-1",
      testRoutine.instruction,
    ]);

    // The prompt is the routine's own instruction and the nonce is namespaced,
    // so a test run can never collide with a scheduled fire's ledger key.
    const runCall = database.calls[3];
    expect(runCall?.text).toContain("on conflict (space_id, client_nonce) do nothing");
    expect(runCall?.values).toEqual([
      "space-1",
      "bot-1",
      "thread-1",
      "task-1",
      "user-1",
      INITIAL_RUN_STATUS,
      routineTestRunNonce(testRoutine.id, "nonce-test"),
    ]);
    expect(database.calls.some((call) => call.text.includes("routine_occurrence"))).toBe(false);
    expect(database.calls.some((call) => call.text.startsWith("update routine"))).toBe(false);
  });

  it("replays the first run when the nonce already exists", async () => {
    const database = fakeDatabase([
      [/from routine where id = \$1 and space_id = \$2 and deleted_at is null/, [testRoutine]],
      [/insert into task/, [task]],
      [/insert into run/, []],
      [/select .* from run where space_id/, [testRun]],
    ]);

    const created = await createRoutineTestRun(owner, database, testRequest);

    expect(created).toEqual(testRun);
    expect(database.calls.filter((call) => call.text === "rollback")).toHaveLength(1);
    expect(database.calls).toContainEqual({
      text: "select " + runColumns + " from run where space_id = $1 and client_nonce = $2",
      values: ["space-1", routineTestRunNonce(testRoutine.id, "nonce-test")],
    });
  });

  it("reports a routine outside the actor's space as not-found and writes nothing", async () => {
    const database = fakeDatabase();

    const rejected = await createRoutineTestRun(owner, database, {
      ...testRequest,
      routineId: "routine-other",
    }).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(NotFoundError);
    expect(rejected).toMatchObject({ resource: "routine", id: "routine-other" });
    expect(database.calls.some((call) => call.text.startsWith("insert into run"))).toBe(false);
    expect(database.calls).toContainEqual({ text: "rollback", values: [] });
  });
});

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));

function shippedSourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return shippedSourceFiles(path);
    }

    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      return [];
    }

    return [path];
  });
}

describe("the one run-creation path", () => {
  it("is the only shipped source in the package that inserts a run", () => {
    const inserting = shippedSourceFiles(sourceDirectory)
      .filter((file) => /insert\s+into\s+run\b/i.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceDirectory, file));

    expect(inserting).toEqual(["run-creation.ts"]);
  });
});
