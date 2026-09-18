import { randomUUID } from "node:crypto";
import {
  createThreadSnapshot,
  parseRunEvent,
  reduceRunEvents,
  RUN_EVENT_SCHEMA_VERSION,
} from "@porkbot/core";
import type { RunEvent, ToolResultLimits } from "@porkbot/core";
import { createRunEventRecorder, NotFoundError } from "@porkbot/effect";
import type { ToolCall } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import type { EventRecord } from "../../src/records.ts";
import { createRepositories } from "../../src/repositories.ts";
import type { UserRepositories } from "../../src/repositories.ts";
import { createRunEventSink } from "../../src/run-event-sink.ts";
import { createExternalEffectLedger } from "../../src/tool-call-ledger.ts";

/**
 * The tool-call timeline where durability lives: in Postgres.
 *
 * A run's events are recorded and appended exactly as the worker will append
 * them, then read back through the actor-scoped repository the subscription
 * uses and reconstructed into wire events the same way `apps/api` does. The
 * properties this suite proves are the slice's: the round trip is lossless
 * enough that reducing the replayed stream equals reducing the live one —
 * including redacted arguments, a truncated result pointed at its artifact and
 * a measured duration — the secret-shaped argument is redacted in the durable
 * payload, the full result is still readable from the effect row the artifact
 * names, and a thread or run outside the actor's space writes nothing.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let user: UserActor;
let runId: string;
let threadId: string;
let otherThreadId: string;
let otherSpace: string;

const limits: ToolResultLimits = { maxInlineBytes: 256, previewBytes: 64 };

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_run_events" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  const space = await insertSpace("Run events A");
  otherSpace = await insertSpace("Run events B");
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
  threadId = thread.id;

  const otherThread = await repositories.threads.createForBot(bot.id);
  otherThreadId = otherThread.id;

  const created = await repositories.runs.create({
    threadId: thread.id,
    clientNonce: randomUUID(),
    prompt: "Do some work",
    blocks: [{ type: "text", text: "Do some work" }],
  });
  runId = created.run.id;
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

function systemActor(spaceId: string): SystemActor {
  return { kind: "system", spaceId, jobId: `job-${randomUUID()}` };
}

const call = (callId: string, callArguments: unknown): ToolCall => ({
  runId,
  callId,
  tool: "shell",
  arguments: callArguments,
});

const base = (seq: number) =>
  ({ schemaVersion: RUN_EVENT_SCHEMA_VERSION, seq, threadId, runId }) as const;

/**
 * The events one run emits, in order: a completed call whose arguments carry a
 * secret shape and whose result is far past the inline budget, a failed call,
 * and the terminal event. The recorder is given a manual clock so the measured
 * durations are the ones asserted.
 */
function script(): readonly RunEvent[] {
  return [
    { ...base(1), type: "run.started" },
    {
      ...base(2),
      type: "tool.requested",
      callId: "call-ok",
      tool: "shell",
      arguments: { command: "cat report.txt", token: "sk-live-0123456789" },
    },
    {
      ...base(3),
      type: "tool.completed",
      callId: "call-ok",
      result: { stdout: "x".repeat(4_096) },
    },
    {
      ...base(4),
      type: "tool.requested",
      callId: "call-denied",
      tool: "rm",
      arguments: { path: "/etc" },
    },
    { ...base(5), type: "tool.failed", callId: "call-denied", error: "operator denied" },
    { ...base(6), type: "run.completed", messageId: "assistant-1" },
  ];
}

/**
 * Records the script the way the run executor will: each frame through the one
 * recorder, then appended at its own position. The clock moves only between a
 * request and its resolution, so the recorded durations are deterministic.
 */
async function recordAndAppend(
  actor: SystemActor,
  events: readonly RunEvent[],
): Promise<readonly RunEvent[]> {
  let now = 0;
  const recorder = createRunEventRecorder({ clock: () => now, limits });
  const sink = createRunEventSink(actor, db());
  const recorded: RunEvent[] = [];

  for (const event of events) {
    if (event.type === "tool.completed" || event.type === "tool.failed") {
      now += 250;
    }

    const frame = recorder.record(event);
    recorded.push(frame);
    await sink.append(frame);
  }

  return recorded;
}

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

describe("the persisted tool-call timeline", () => {
  it("round-trips a run's events into the same reduced timeline the wire showed", async () => {
    const recorded = await recordAndAppend(systemActor(user.spaceId), script());

    const repositories = createRepositories(user, db());
    const rows = await repositories.events.listAfter(threadId, 0, 100);
    const replayed = rows.map(runEventFor);

    expect(replayed.map((event) => event.type)).toEqual(recorded.map((event) => event.type));

    const live = reduceRunEvents(createThreadSnapshot(threadId), recorded);
    const afterReload = reduceRunEvents(createThreadSnapshot(threadId), replayed);

    expect(live.ok).toBe(true);
    expect(afterReload).toEqual(live);
  });

  it("redacts the persisted arguments and truncates the persisted result with a pointer", async () => {
    const repositories = createRepositories(user, db());
    const rows = await repositories.events.listAfter(threadId, 0, 100);
    const requested = rows.find(
      (row) => row.type === "tool.requested" && row.payload["callId"] === "call-ok",
    );
    const completed = rows.find((row) => row.type === "tool.completed");

    expect(requested?.payload).toMatchObject({
      callId: "call-ok",
      tool: "shell",
      arguments: { command: "cat report.txt", token: "[redacted]" },
    });
    expect(JSON.stringify(requested?.payload)).not.toContain("sk-live-0123456789");

    const preview = String(completed?.payload["result"]);
    expect(preview.endsWith("[truncated]")).toBe(true);
    expect(completed?.payload["resultArtifact"]).toMatchObject({
      kind: "tool_call",
      callId: "call-ok",
    });
    expect(
      Number((completed?.payload["resultArtifact"] as { bytes: number }).bytes),
    ).toBeGreaterThan(limits.maxInlineBytes);
    expect(completed?.payload["durationMs"]).toBe(250);
  });

  it("keeps the full result readable from the artifact the event points at", async () => {
    const actor = systemActor(user.spaceId);
    const ledger = createExternalEffectLedger(actor, db());
    const completedCall = call("call-ok", {
      command: "cat report.txt",
      token: "sk-live-0123456789",
    });
    const fullResult = { stdout: "x".repeat(4_096) };

    await ledger.begin(completedCall);
    await ledger.complete(completedCall, fullResult);

    const repositories = createRepositories(user, db());
    const rows = await repositories.events.listAfter(threadId, 0, 100);
    const completed = rows.find((row) => row.type === "tool.completed");
    const artifact = completed?.payload["resultArtifact"] as
      { readonly kind: "tool_call"; readonly callId: string; readonly bytes: number } | undefined;

    expect(artifact?.callId).toBe("call-ok");

    const { rows: effects } = await db().query<{
      readonly status: string;
      readonly request: unknown;
      readonly result: unknown;
    }>(
      "select status::text as status, request, result from external_effect " +
        "where run_id = $1 and idempotency_key = $2",
      [runId, artifact?.callId],
    );

    expect(effects[0]?.result).toEqual(fullResult);
    expect(effects[0]?.request).toEqual({ command: "cat report.txt", token: "[redacted]" });

    // Replaying the call is the read path after the run ends: the ledger
    // answers with the whole value the event only previews.
    const replayed = await ledger.begin(completedCall);
    expect(replayed).toEqual({ status: "completed", result: fullResult });
  });

  it("advances the thread's event counter past every appended position", async () => {
    const { rows } = await db().query<{ readonly nextEventSeq: number }>(
      'select next_event_seq as "nextEventSeq" from thread where id = $1',
      [threadId],
    );

    expect(rows[0]?.nextEventSeq).toBe(7);
  });
});

describe("an event outside the actor's scope", () => {
  it("refuses the append and writes nothing when the thread is in another space", async () => {
    const before = await eventCount();
    const foreign = systemActor(otherSpace);
    const event: RunEvent = { ...base(99), type: "run.started" };

    await expect(createRunEventSink(foreign, db()).append(event)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await eventCount()).toBe(before);
  });

  it("refuses a position that was already written rather than overwriting it", async () => {
    const actor = systemActor(user.spaceId);
    const duplicate: RunEvent = {
      ...base(6),
      type: "run.completed",
      messageId: "assistant-1",
    };

    await expect(createRunEventSink(actor, db()).append(duplicate)).rejects.toThrow();
    expect(await eventCount()).toBe(6);
  });

  it("refuses an event whose run belongs to another thread", async () => {
    const event: RunEvent = { ...base(1), type: "run.started", threadId: otherThreadId };

    await expect(
      createRunEventSink(systemActor(user.spaceId), db()).append(event),
    ).rejects.toMatchObject({ _tag: "NotFoundError", resource: "run" });

    const { rows } = await db().query("select id from event where thread_id = $1", [otherThreadId]);
    expect(rows).toHaveLength(0);
  });
});

async function eventCount(): Promise<number> {
  const { rows } = await db().query<{ readonly count: string }>(
    "select count(*)::text as count from event where thread_id = $1",
    [threadId],
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
