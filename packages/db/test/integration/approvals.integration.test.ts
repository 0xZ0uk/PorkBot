import { randomUUID } from "node:crypto";
import {
  createThreadSnapshot,
  parseRunEvent,
  reduceRunEvents,
  RUN_EVENT_SCHEMA_VERSION,
} from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { createApprovalGate, GateTimeoutError, NotFoundError } from "@porkbot/effect";
import type { ApprovalRecord, ApprovalStore, UserActor } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Effect, Either } from "effect";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApprovalStore } from "../../src/approval-store.ts";
import type { SystemActor } from "../../src/actor.ts";
import type { EventRecord } from "../../src/records.ts";
import { createRepositories } from "../../src/repositories.ts";
import type { UserRepositories } from "../../src/repositories.ts";
import { createRunEventSink } from "../../src/run-event-sink.ts";

/**
 * Approval durability proven where durability lives: in Postgres.
 *
 * The unit suite in `@porkbot/effect` proves the gate's half over an in-memory
 * store; this suite composes the same gate with the real `approval` rows and
 * answers what only a server can. A gate opened by one worker reopens in
 * another on the original deadline; an offline operator's gate is timed out by
 * a guarded compare-and-set and the run answers the typed `GateTimeoutError`; a
 * vote records the user, the instant and the call id; concurrent votes resolve
 * exactly once; and a run outside the actor's space is not-found and writes
 * nothing.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;
const extraClients: Client[] = [];

let user: UserActor;
let userId: string;
let runId: string;
let threadId: string;
let otherSpace: string;

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

async function connect(): Promise<Client> {
  if (suite === undefined) {
    throw new Error("the suite was not created; the beforeAll hook failed first");
  }

  const connected = new Client({ connectionString: suite.connectionString });
  await connected.connect();
  extraClients.push(connected);
  return connected;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_approvals" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  const space = await insertSpace("Approvals A");
  otherSpace = await insertSpace("Approvals B");
  userId = await insertUser("Alice");
  await insertMembership(space, userId, "owner");

  user = { kind: "user", spaceId: space, userId, role: "owner" };
  const repositories: UserRepositories = createRepositories(user, db());
  const bot = await repositories.bots.create({
    name: "Ada",
    color: "#4f46e5",
    spawnKey: randomUUID(),
  });
  const thread = await repositories.threads.createForBot(bot.id);
  threadId = thread.id;
  const created = await repositories.runs.create({
    threadId: thread.id,
    clientNonce: randomUUID(),
    prompt: "Say hello",
    blocks: [{ type: "text", text: "Say hello" }],
  });
  runId = created.run.id;
}, 180_000);

afterAll(async () => {
  await Promise.all(extraClients.map(async (extra) => extra.end()));
  await client?.end();
  await suite?.destroy();
});

function systemActor(spaceId: string): SystemActor {
  return { kind: "system", spaceId, jobId: `job-${randomUUID()}` };
}

function stores(actor: SystemActor): ApprovalStore {
  return createApprovalStore(actor, db());
}

const future = (seconds: number) => new Date(Date.now() + seconds * 1_000);

const frame = (seq: number) =>
  ({ schemaVersion: RUN_EVENT_SCHEMA_VERSION, seq, threadId, runId }) as const;

/** The reconstruction `apps/api`'s subscription performs, pinned to the row. */
function runEventFor(record: EventRecord): RunEvent {
  const parsed = parseRunEvent({
    ...record.payload,
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq: record.seq,
    threadId: record.threadId,
    runId: record.runId,
    type: record.type,
  });

  if (!parsed.ok) {
    throw parsed.error;
  }

  return parsed.event;
}

async function row(run: string, call: string): Promise<ApprovalRecord | undefined> {
  const { rows } = await db().query<ApprovalRecord>(
    'select id, run_id as "runId", call_id as "callId", tool, arguments, ' +
      'status::text as status, expires_at as "expiresAt", ' +
      'decided_by_user_id as "decidedBy", decided_at as "decidedAt", reason ' +
      "from approval where run_id = $1 and call_id = $2",
    [run, call],
  );

  return rows[0];
}

describe("a gate that outlives the worker", () => {
  it("reopens the same pending row on the original deadline after a restart", async () => {
    const callId = `call-restart-${randomUUID()}`;
    const deadline = future(600);
    const opened = await stores(systemActor(user.spaceId)).open({
      runId,
      callId,
      tool: "shell",
      arguments: { command: "printf ready" },
      expiresAt: deadline,
    });

    expect(opened.status).toBe("pending");
    expect(opened.expiresAt).toEqual(deadline);

    // A restart is a new process, a new job id and a new store over the same
    // rows; the gate must not be asked twice or moved to a new deadline.
    const restarted = stores(systemActor(user.spaceId));
    const reopened = await restarted.open({
      runId,
      callId,
      tool: "shell",
      arguments: { command: "printf ready" },
      expiresAt: future(5),
    });

    expect(reopened.id).toBe(opened.id);
    expect(reopened.expiresAt).toEqual(deadline);
    expect(reopened.status).toBe("pending");
  });

  it("serves a reloading client the pending gate and the decision it became", async () => {
    const callId = `call-reload-${randomUUID()}`;
    await stores(systemActor(user.spaceId)).open({
      runId,
      callId,
      tool: "shell",
      arguments: {},
      expiresAt: future(600),
    });

    const operator = createApprovalStore(user, db());
    const pending = await operator.listForRun(runId);
    expect(pending.find((record) => record.callId === callId)?.status).toBe("pending");

    await operator.decide({ runId, callId, vote: "deny", reason: "not this one" });

    const after = await operator.listForRun(runId);
    expect(after.find((record) => record.callId === callId)).toMatchObject({
      status: "denied",
      decidedBy: userId,
      reason: "not this one",
    });
  });
});

describe("an offline operator", () => {
  it("times out to a typed deny instead of hanging the run", async () => {
    const callId = `call-offline-${randomUUID()}`;
    const store = stores(systemActor(user.spaceId));
    const gate = createApprovalGate({ runId, store, timeoutMs: 200, pollIntervalMs: 20 });

    const opened = await Effect.runPromise(
      gate.open({ callId, tool: "shell", arguments: { command: "printf ready" } }),
    );
    const outcome = await Effect.runPromise(gate.waitFor(opened).pipe(Effect.either));

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(GateTimeoutError);
    }

    const settled = await row(runId, callId);
    expect(settled?.status).toBe("timed_out");
    expect(settled?.decidedAt).not.toBeNull();
    expect(settled?.decidedBy).toBeNull();
  });

  it("carries the timeout to a reloading client through the durable stream", async () => {
    const callId = `call-events-${randomUUID()}`;
    const gate = createApprovalGate({
      runId,
      store: stores(systemActor(user.spaceId)),
      timeoutMs: 200,
      pollIntervalMs: 20,
    });

    const opened = await Effect.runPromise(
      Effect.gen(function* () {
        const record = yield* gate.open({
          callId,
          tool: "shell",
          arguments: { command: "printf ready" },
        });
        const outcome = yield* gate.waitFor(record).pipe(Effect.either);
        expect(Either.isLeft(outcome)).toBe(true);
        return record;
      }),
    );

    const events: readonly RunEvent[] = [
      { ...frame(1), type: "run.started" },
      { ...frame(2), type: "tool.requested", callId, tool: "shell", arguments: {} },
      {
        ...frame(3),
        type: "approval.requested",
        callId,
        expiresAt: opened.expiresAt.toISOString(),
      },
      { ...frame(4), type: "approval.resolved", callId, decision: "timed_out" },
      { ...frame(5), type: "tool.failed", callId, error: "the approval gate timed out" },
    ];

    // The executor's half: each frame through the shared recorder, then the
    // durable sink at the position the session allocated.
    const sink = createRunEventSink(systemActor(user.spaceId), db());
    for (const event of events) {
      await sink.append(event);
    }

    // The client's half after a reload: reconstruct from the actor-scoped rows
    // the subscription replays, then reduce both streams.
    const rows = await createRepositories(user, db()).events.listAfter(threadId, 0, 100);
    const replayed = rows.map(runEventFor);
    const live = reduceRunEvents(createThreadSnapshot(threadId), events);
    const afterReload = reduceRunEvents(createThreadSnapshot(threadId), replayed);

    expect(afterReload).toEqual(live);
    expect(afterReload.ok).toBe(true);

    if (afterReload.ok) {
      const run = afterReload.snapshot.runs[0];
      expect(run?.status).toBe("running");
      expect(run?.toolCalls[0]).toMatchObject({
        status: "failed",
        approval: { status: "timed_out" },
      });
    }
  });

  it("settles a vote that arrives after the deadline as the timeout, not an approval", async () => {
    const callId = `call-late-${randomUUID()}`;
    const actor = systemActor(user.spaceId);
    await stores(actor).open({
      runId,
      callId,
      tool: "shell",
      arguments: {},
      expiresAt: future(-1),
    });

    const result = await createApprovalStore(user, db()).decide({
      runId,
      callId,
      vote: "approve",
    });

    expect(result.applied).toBe(false);
    expect(result.record.status).toBe("timed_out");
    expect(result.record.decidedBy).toBeNull();
  });

  it("does not time out a gate the server clock still holds open", async () => {
    const callId = `call-early-${randomUUID()}`;
    const actor = systemActor(user.spaceId);
    await stores(actor).open({
      runId,
      callId,
      tool: "shell",
      arguments: {},
      expiresAt: future(600),
    });

    const settled = await stores(actor).resolveTimeout(runId, callId);

    expect(settled.status).toBe("pending");
    expect((await row(runId, callId))?.status).toBe("pending");
  });
});

describe("an operator who answers", () => {
  it("records who, when, which call and what it was asked to do", async () => {
    const callId = `call-decided-${randomUUID()}`;
    await stores(systemActor(user.spaceId)).open({
      runId,
      callId,
      tool: "web",
      arguments: { url: "https://example.com/page" },
      expiresAt: future(600),
    });

    const result = await createApprovalStore(user, db()).decide({
      runId,
      callId,
      vote: "approve",
    });

    expect(result.applied).toBe(true);
    expect(result.record).toMatchObject({
      runId,
      callId,
      tool: "web",
      arguments: { url: "https://example.com/page" },
      status: "approved",
      decidedBy: userId,
      reason: null,
    });
    expect(result.record.decidedAt).toBeInstanceOf(Date);

    // The payload survives the jsonb column, so a reloading client or an
    // audit reads the same call the operator approved.
    expect((await row(runId, callId))?.arguments).toEqual({
      url: "https://example.com/page",
    });
  });

  it("resolves exactly once when approve and deny race", async () => {
    const callId = `call-race-${randomUUID()}`;
    await stores(systemActor(user.spaceId)).open({
      runId,
      callId,
      tool: "shell",
      arguments: {},
      expiresAt: future(600),
    });

    const racers = await Promise.all([connect(), connect(), connect(), connect()]);
    const votes = await Promise.all(
      racers.map(async (racer, index) =>
        createApprovalStore(user, racer).decide({
          runId,
          callId,
          vote: index % 2 === 0 ? "approve" : "deny",
          reason: index % 2 === 0 ? undefined : "no",
        }),
      ),
    );

    expect(votes.filter((vote) => vote.applied)).toHaveLength(1);
    expect(new Set(votes.map((vote) => vote.record.status)).size).toBe(1);

    const settled = await row(runId, callId);
    expect(settled?.status === "approved" || settled?.status === "denied").toBe(true);
    expect(settled?.decidedBy).toBe(userId);
    expect(settled?.decidedAt).not.toBeNull();
  });

  it("refuses a resolved row that loses its author", async () => {
    const callId = `call-orphan-${randomUUID()}`;
    await stores(systemActor(user.spaceId)).open({
      runId,
      callId,
      tool: "shell",
      arguments: {},
      expiresAt: future(600),
    });

    await expect(
      db().query(
        "update approval set status = 'approved', decided_at = now() " +
          "where run_id = $1 and call_id = $2",
        [runId, callId],
      ),
    ).rejects.toThrow(/approval_resolution_check/);
  });

  it("refuses a gate without an addressable call id or tool", async () => {
    for (const [call, tool] of [
      ["   ", "shell"],
      ["call-blank-tool", " "],
    ]) {
      await expect(
        db().query(
          "insert into approval (space_id, run_id, call_id, tool, status, expires_at) " +
            "values ($1, $2, $3, $4, 'pending', now() + interval '10 minutes')",
          [user.spaceId, runId, call, tool],
        ),
      ).rejects.toThrow(/approval_identifiers_check/);
    }
  });
});

describe("actor scope", () => {
  it("answers not-found for a run in another space and writes nothing", async () => {
    const callId = `call-cross-space-${randomUUID()}`;
    const error = await stores(systemActor(otherSpace))
      .open({ runId, callId, tool: "shell", arguments: {}, expiresAt: future(600) })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(NotFoundError);

    const { rows } = await db().query("select id from approval where call_id = $1", [callId]);
    expect(rows).toHaveLength(0);
  });

  it("answers not-found for a vote from another space and leaves the gate pending", async () => {
    const callId = `call-foreign-vote-${randomUUID()}`;
    await stores(systemActor(user.spaceId)).open({
      runId,
      callId,
      tool: "shell",
      arguments: {},
      expiresAt: future(600),
    });

    const foreign: UserActor = {
      kind: "user",
      spaceId: otherSpace,
      userId,
      role: "owner",
    };

    await expect(
      createApprovalStore(foreign, db()).decide({ runId, callId, vote: "approve" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(runId, callId))?.status).toBe("pending");
    expect(await createApprovalStore(foreign, db()).listForRun(runId)).toEqual([]);
  });
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
