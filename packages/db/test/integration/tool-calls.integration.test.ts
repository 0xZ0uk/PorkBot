import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { LeaseLostError, ToolCallConflictError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExternalEffectLedger } from "../../src/tool-call-ledger.ts";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";
import type { UserRepositories } from "../../src/repositories.ts";
import { createToolDispatcher } from "@porkbot/effect";
import type { ToolCall, ToolDispatcher, ToolRegistration } from "@porkbot/effect";

/**
 * Tool-call idempotency proven where durability lives: in Postgres.
 *
 * The unit suite in `@porkbot/effect` proves the dispatcher's half over an
 * in-memory ledger; this suite composes the same dispatcher with the real
 * `external_effect` ledger and answers what only a server can. A retried call
 * replays the stored outcome and runs its side effect exactly once — across a
 * fresh dispatcher, which is what a retry after a worker restart looks like. A
 * call id reused for a different request, and one still claimed, are typed
 * conflicts rather than second effects. A run outside the actor's space is
 * not-found and writes nothing.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let user: UserActor;
let runId: string;
let otherSpace: string;

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_tool_calls" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  const space = await insertSpace("Tool calls A");
  otherSpace = await insertSpace("Tool calls B");
  const userId = await insertUser("Alice");
  await insertMembership(space, userId, "owner");

  user = { kind: "user", spaceId: space, userId, role: "owner" };
  const repositories: UserRepositories = createRepositories(user, db());
  const bot = await repositories.bots.create({
    name: "Ada",
    color: "#4f46e5",
    spawnKey: randomUUID(),
  });
  const thread = await repositories.threads.createForBot(bot.id);
  const created = await repositories.runs.create({
    threadId: thread.id,
    clientNonce: randomUUID(),
    prompt: "Say hello",
    blocks: [{ type: "text", text: "Say hello" }],
  });
  runId = created.run.id;

  await db().query(
    "create table tool_effect_log (id uuid primary key default uuidv7(), note text not null)",
  );
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

function systemActor(spaceId: string): SystemActor {
  return { kind: "system", spaceId, jobId: `job-${randomUUID()}` };
}

/**
 * A dispatcher over the real ledger whose one tool writes a row per execution,
 * so "the side effect happened once" is a count in a table rather than a
 * mock's opinion.
 */
function dispatcherOverDatabase(
  actor: SystemActor,
  onExecute?: (call: ToolCall) => Promise<unknown>,
): ToolDispatcher {
  const tool: ToolRegistration = {
    name: "echo",
    description: "Record the call and echo its arguments.",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    maxDurationMs: 5_000,
    execute: (call) =>
      Effect.tryPromise(async () => {
        if (onExecute !== undefined) {
          return onExecute(call);
        }

        await db().query("insert into tool_effect_log (note) values ($1)", [call.callId]);
        return { echoed: call.arguments };
      }),
  };

  return createToolDispatcher({
    registrations: [tool],
    ledger: createExternalEffectLedger(actor, db()),
    leaseTtlMs: 60_000,
    heartbeat: Effect.void,
  });
}

const call = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  runId,
  callId: randomUUID(),
  tool: "echo",
  arguments: { text: "hi" },
  ...overrides,
});

/**
 * A failure classified the way `@porkbot/adapters` classifies provider errors:
 * `kind` and `detail` are the safe, model-visible text, while the `Error`
 * message is the vendor text that must never be recorded or replayed.
 */
class RefusedError extends Error {
  readonly kind = "timed_out";
  readonly detail = "the provider did not answer in time";

  constructor() {
    super("raw vendor text");
  }
}

describe("a retried tool call", () => {
  it("replays the stored outcome and runs its side effect once", async () => {
    const dispatcher = dispatcherOverDatabase(systemActor(user.spaceId));
    const first = call({ callId: "call-once" });

    const completed = await Effect.runPromise(dispatcher.execute(first));
    const replayed = await Effect.runPromise(dispatcher.execute(first));

    expect(completed).toEqual({ status: "completed", result: { echoed: { text: "hi" } } });
    expect(replayed).toEqual(completed);
    expect(await effectCount("call-once")).toBe(1);

    const { rows } = await db().query<{
      kind: string;
      idempotencyKey: string;
      status: string;
      request: unknown;
    }>(
      'select kind, idempotency_key as "idempotencyKey", status, request ' +
        "from external_effect where run_id = $1 and idempotency_key = $2",
      [runId, "call-once"],
    );

    expect(rows).toEqual([
      {
        kind: "echo",
        idempotencyKey: "call-once",
        status: "completed",
        request: { text: "hi" },
      },
    ]);
  });

  it("replays across a fresh dispatcher, the shape of a retry after restart", async () => {
    const first = call({ callId: "call-restart" });
    await Effect.runPromise(dispatcherOverDatabase(systemActor(user.spaceId)).execute(first));

    const second = dispatcherOverDatabase(systemActor(user.spaceId), async () => {
      await db().query("insert into tool_effect_log (note) values ('should not run')");
      return "second handler ran";
    });
    const replayed = await Effect.runPromise(second.execute(first));

    expect(replayed).toEqual({ status: "completed", result: { echoed: { text: "hi" } } });
    expect(await effectCount("call-restart")).toBe(1);
    expect(await effectCount("should not run")).toBe(0);
  });

  it("records and replays a classified failure without re-running the handler", async () => {
    let runs = 0;
    const dispatcher = dispatcherOverDatabase(systemActor(user.spaceId), async () => {
      runs += 1;
      throw new RefusedError();
    });
    const failedCall = call({ callId: "call-failed" });

    const first = await Effect.runPromise(dispatcher.execute(failedCall));
    const replayed = await Effect.runPromise(dispatcher.execute(failedCall));

    expect(first).toEqual({
      status: "failed",
      error: 'tool "echo" failed (timed_out): the provider did not answer in time',
    });
    expect(replayed).toEqual(first);
    expect(runs).toBe(1);

    const { rows } = await db().query<{ readonly result: unknown }>(
      "select result from external_effect where run_id = $1 and idempotency_key = $2",
      [runId, "call-failed"],
    );
    expect(rows[0]?.result).toEqual({
      error: 'tool "echo" failed (timed_out): the provider did not answer in time',
    });
  });

  it("settles a result the ledger cannot carry as failed, and replays that", async () => {
    let runs = 0;
    const dispatcher = dispatcherOverDatabase(systemActor(user.spaceId), async () => {
      runs += 1;
      return 10n;
    });
    const unrecordable = call({ callId: "call-unrecordable" });

    const first = await Effect.runPromise(dispatcher.execute(unrecordable));
    const replayed = await Effect.runPromise(dispatcher.execute(unrecordable));

    expect(first).toEqual({ status: "failed", error: "the tool result could not be recorded" });
    expect(replayed).toEqual(first);
    expect(runs).toBe(1);
  });
});

describe("a call id that is not a replay", () => {
  it("refuses a call id reused for a different request", async () => {
    const dispatcher = dispatcherOverDatabase(systemActor(user.spaceId));
    await Effect.runPromise(dispatcher.execute(call({ callId: "call-reused" })));

    const conflict = await Effect.runPromise(
      dispatcher
        .execute(call({ callId: "call-reused", arguments: { text: "different" } }))
        .pipe(Effect.flip),
    );

    expect(conflict).toBeInstanceOf(ToolCallConflictError);
    expect((conflict as ToolCallConflictError).reason).toBe("call_id_reused");
    expect(await effectCount("call-reused")).toBe(1);
  });

  it("refuses a call id another attempt is still holding", async () => {
    const actor = systemActor(user.spaceId);
    const ledger = createExternalEffectLedger(actor, db());
    const claimed = call({ callId: "call-in-flight" });
    const admission = await ledger.begin(claimed);
    expect(admission).toEqual({ status: "started" });

    const error = await Effect.runPromise(
      dispatcherOverDatabase(actor).execute(claimed).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(ToolCallConflictError);
    expect((error as ToolCallConflictError).reason).toBe("in_flight");
    expect(await effectCount("call-in-flight")).toBe(0);
  });

  it("leaves the claim in flight when the lease is lost before the handler", async () => {
    const actor = systemActor(user.spaceId);
    const claimed = call({ callId: "call-lost-lease" });
    const losing = createToolDispatcher({
      registrations: [
        {
          name: "echo",
          description: "Never runs.",
          parameters: {},
          maxDurationMs: 5_000,
          execute: () => Effect.succeed("ran"),
        },
      ],
      ledger: createExternalEffectLedger(actor, db()),
      leaseTtlMs: 60_000,
      heartbeat: Effect.fail(new LeaseLostError(runId)),
    });

    const error = await Effect.runPromise(losing.execute(claimed).pipe(Effect.flip));
    expect(error).toBeInstanceOf(LeaseLostError);
    expect(await effectCount("call-lost-lease")).toBe(0);

    // The claim is durable: a retry that has a live lease is refused rather
    // than run twice, and reclaim (slices 6.2/6.3) owns settling it.
    const retry = await Effect.runPromise(
      dispatcherOverDatabase(actor).execute(claimed).pipe(Effect.flip),
    );
    expect(retry).toBeInstanceOf(ToolCallConflictError);
    expect((retry as ToolCallConflictError).reason).toBe("in_flight");
  });

  it("settles the claim on reclaim, and the superseded owner can no longer confirm it", async () => {
    const actor = systemActor(user.spaceId);
    const reason = "the previous owner's lease expired and no heartbeat renewed it";
    const ledger = createExternalEffectLedger(actor, db());
    const claimed = call({ callId: "call-reconciled" });
    expect(await ledger.begin(claimed)).toEqual({ status: "started" });

    // The owner that admitted the call dies; another worker reclaims the run.
    const repos = createRepositories(systemActor(user.spaceId), db());
    const lease = await repos.runs.claim(runId, 0, "worker-a");
    if (lease === undefined) {
      throw new Error("expected the queued run to be claimable");
    }

    await db().query(
      "update run set lease_expires_at = now() - interval '1 second' where id = $1",
      [runId],
    );

    const reclaimer = createRepositories(systemActor(user.spaceId), db());
    const reclaimed = await reclaimer.runs.reclaim(runId, lease.leaseFence, "worker-b", { reason });
    expect(reclaimed?.leaseFence).toBe(lease.leaseFence + 1);

    // The superseded owner's completion is refused — the claim is no longer
    // its to settle — and the row keeps the reconciliation's record.
    await expect(ledger.complete(claimed, { sent: true })).rejects.toThrow(
      /no longer holds the claim/,
    );

    const { rows } = await db().query<{ readonly status: string; readonly result: unknown }>(
      "select status::text as status, result from external_effect where run_id = $1 and idempotency_key = $2",
      [runId, "call-reconciled"],
    );
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.result).toEqual({ error: reason });

    // A resume retrying the same call id replays the recorded failure and
    // never runs the handler.
    const replayed = await Effect.runPromise(
      dispatcherOverDatabase(systemActor(user.spaceId)).execute(claimed),
    );
    expect(replayed).toEqual({ status: "failed", error: reason });
    expect(await effectCount("call-reconciled")).toBe(0);
  });
});

describe("actor scope", () => {
  it("answers not-found for a run in another space and writes nothing", async () => {
    const foreign = systemActor(otherSpace);
    const error = await Effect.runPromise(
      dispatcherOverDatabase(foreign)
        .execute(call({ callId: "call-cross-space" }))
        .pipe(Effect.flip),
    );

    expect(error).toMatchObject({ _tag: "NotFoundError" });
    expect(await effectCount("call-cross-space")).toBe(0);

    const { rows } = await db().query("select id from external_effect where idempotency_key = $1", [
      "call-cross-space",
    ]);
    expect(rows).toHaveLength(0);
  });
});

async function effectCount(note: string): Promise<number> {
  const { rows } = await db().query<{ readonly count: string }>(
    "select count(*)::text as count from tool_effect_log where note = $1",
    [note],
  );

  return Number(rows[0]?.count ?? "0");
}

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
