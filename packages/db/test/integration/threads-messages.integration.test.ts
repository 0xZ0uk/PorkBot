import { randomUUID } from "node:crypto";
import { RUN_EVENT_SCHEMA_VERSION, textMessageBlocks } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createMemoryStore } from "../../src/memory-store.ts";
import { createAssistantMessageStore } from "../../src/messages.ts";
import { createRepositories } from "../../src/repositories.ts";
import type { UserRepositories } from "../../src/repositories.ts";
import { createRunEventSink } from "../../src/run-event-sink.ts";

/**
 * Threads and messages where the acceptance criteria actually live: in
 * Postgres, across two spaces and two connections.
 *
 * The unit suites prove the commands' own shape against a recording fake; this
 * suite answers what only a server can. A send creates one run and a
 * resubmitted nonce creates none, including when two connections race the same
 * nonce. The transcript and the thread list page in a stable order without
 * gaps or repeats. Another space's thread is invisible to every read and
 * write. Assistant messages and tool events persist with no stream open,
 * because persistence never depended on a subscriber. And clearing a thread
 * empties its transcript and events while its runs and the bot's memory
 * documents survive, which is the rule the clear exists to state.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;
const extraClients: Client[] = [];

let alice: UserActor;
let bob: UserActor;
let aliceRepositories: UserRepositories;
let bobRepositories: UserRepositories;
let botA: string;
let botB: string;
let threadB: string;

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
  suite = await createSuiteDatabase({ suite: "db_threads_messages" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  const spaceA = await insertSpace("Threads A");
  const spaceB = await insertSpace("Threads B");
  const userId = await insertUser("Alice");
  const bobId = await insertUser("Bob");

  await insertMembership(spaceA, userId, "owner");
  await insertMembership(spaceB, bobId, "owner");

  alice = { kind: "user", spaceId: spaceA, userId, role: "owner" };
  bob = { kind: "user", spaceId: spaceB, userId: bobId, role: "owner" };

  aliceRepositories = createRepositories(alice, db());
  bobRepositories = createRepositories(bob, db());

  botA = (
    await aliceRepositories.bots.create({ name: "Ada", color: "#4f46e5", spawnKey: randomUUID() })
  ).id;
  botB = (
    await bobRepositories.bots.create({ name: "Grace", color: "#059669", spawnKey: randomUUID() })
  ).id;

  threadB = (await bobRepositories.threads.createForBot(botB)).id;
}, 180_000);

afterAll(async () => {
  await Promise.all(extraClients.map(async (extra) => extra.end()));
  await client?.end();
  await suite?.destroy();
});

function systemActor(spaceId: string): SystemActor {
  return { kind: "system", spaceId, jobId: `job-${randomUUID()}` };
}

function send(threadId: string, text: string) {
  return {
    threadId,
    clientNonce: `send-${randomUUID()}`,
    prompt: text,
    blocks: textMessageBlocks(text),
  };
}

const eventBase = (seq: number, threadId: string, runId: string) =>
  ({ schemaVersion: RUN_EVENT_SCHEMA_VERSION, seq, threadId, runId }) as const;

function startedEvent(seq: number, threadId: string, runId: string): RunEvent {
  return { ...eventBase(seq, threadId, runId), type: "run.started" };
}

function completedToolEvent(seq: number, threadId: string, runId: string): RunEvent {
  return {
    ...eventBase(seq, threadId, runId),
    type: "tool.completed",
    callId: `call-${seq}`,
    result: "ok",
  };
}

describe("a message creates exactly one run", () => {
  it("creates the run once and replays it for a resubmitted nonce", async () => {
    const thread = await aliceRepositories.threads.createForBot(botA);
    const input = send(thread.id, "summarise the inbox");

    const created = await aliceRepositories.runs.create(input);
    const replay = await aliceRepositories.runs.create(input);

    expect(replay.run.id).toBe(created.run.id);
    expect(replay.message.id).toBe(created.message.id);
    expect(replay.message.seq).toBe(created.message.seq);

    const runs = await aliceRepositories.runs.listForThread(thread.id);
    expect(runs.map((run) => run.id)).toEqual([created.run.id]);

    const messages = await aliceRepositories.messages.listForThread(thread.id, {
      afterSeq: -1,
      limit: 10,
    });
    expect(messages.map((message) => message.id)).toEqual([created.message.id]);
  });

  it("produces one run when two connections race the same nonce", async () => {
    const thread = await aliceRepositories.threads.createForBot(botA);
    const first = createRepositories(alice, await connect());
    const second = createRepositories(alice, await connect());
    const input = send(thread.id, "race me");

    const [left, right] = await Promise.all([first.runs.create(input), second.runs.create(input)]);

    expect(left.run.id).toBe(right.run.id);
    expect(await first.runs.listForThread(thread.id)).toHaveLength(1);
  });
});

describe("the transcript pages in order", () => {
  it("walks the messages by sequence without gaps or repeats", async () => {
    const thread = await aliceRepositories.threads.createForBot(botA);

    for (let index = 0; index < 5; index += 1) {
      await aliceRepositories.runs.create(send(thread.id, `message ${index}`));
    }

    const first = await aliceRepositories.messages.listForThread(thread.id, {
      afterSeq: -1,
      limit: 2,
    });
    const second = await aliceRepositories.messages.listForThread(thread.id, {
      afterSeq: first[first.length - 1]?.seq ?? -1,
      limit: 2,
    });
    const third = await aliceRepositories.messages.listForThread(thread.id, {
      afterSeq: second[second.length - 1]?.seq ?? -1,
      limit: 2,
    });

    const walked = [...first, ...second, ...third];
    expect(walked.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(walked.map((message) => message.id)).size).toBe(5);
  });

  it("pages the thread list by last activity, newest first", async () => {
    const bot = (
      await aliceRepositories.bots.create({
        name: "Pager",
        color: "#0ea5e9",
        spawnKey: randomUUID(),
      })
    ).id;

    const threads = [];
    for (let index = 0; index < 5; index += 1) {
      const thread = await aliceRepositories.threads.createForBot(bot);
      threads.push(thread.id);
      await db().query(
        "update thread set updated_at = now() - make_interval(mins => $2) where id = $1",
        [thread.id, index],
      );
    }

    const expected = (await aliceRepositories.threads.listForBot(bot, { limit: 10 })).map(
      (row) => row.id,
    );

    const pageOne = await aliceRepositories.threads.listForBot(bot, { limit: 2 });
    const pageTwo = await aliceRepositories.threads.listForBot(bot, {
      limit: 2,
      before: {
        updatedAt: pageOne[pageOne.length - 1]?.updatedAt ?? new Date(0),
        id: pageOne[pageOne.length - 1]?.id ?? "",
      },
    });
    const pageThree = await aliceRepositories.threads.listForBot(bot, {
      limit: 2,
      before: {
        updatedAt: pageTwo[pageTwo.length - 1]?.updatedAt ?? new Date(0),
        id: pageTwo[pageTwo.length - 1]?.id ?? "",
      },
    });

    const walked = [...pageOne, ...pageTwo, ...pageThree].map((row) => row.id);
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(threads.length);
  });
});

describe("the space boundary", () => {
  it("hides another space's thread from every read and write", async () => {
    await expect(aliceRepositories.threads.findById(threadB)).rejects.toBeInstanceOf(NotFoundError);

    expect(
      await aliceRepositories.messages.listForThread(threadB, { afterSeq: -1, limit: 10 }),
    ).toEqual([]);
    expect(await aliceRepositories.messages.findByNonce(threadB, "nonce-1")).toBeUndefined();
    expect(await aliceRepositories.runs.findActiveForThread(threadB)).toBeUndefined();

    await expect(aliceRepositories.threads.clear(threadB)).rejects.toBeInstanceOf(NotFoundError);

    const created = await bobRepositories.runs.create(send(threadB, "bob's message"));

    await expect(
      aliceRepositories.messages.steer({
        threadId: threadB,
        clientNonce: `steer-${randomUUID()}`,
        blocks: textMessageBlocks("steer"),
        runId: created.run.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      createAssistantMessageStore(systemActor(alice.spaceId), db()).append({
        threadId: threadB,
        runId: created.run.id,
        clientNonce: `assistant-${randomUUID()}`,
        blocks: textMessageBlocks("done"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps a nonce per space, so another space's send is a different send", async () => {
    const nonce = `shared-${randomUUID()}`;
    const foreign = await bobRepositories.runs.create({
      threadId: threadB,
      clientNonce: nonce,
      prompt: "bob's message",
      blocks: textMessageBlocks("bob's message"),
    });

    const ownThread = await aliceRepositories.threads.createForBot(botA);
    const own = await aliceRepositories.runs.create({
      threadId: ownThread.id,
      clientNonce: nonce,
      prompt: "alice's message",
      blocks: textMessageBlocks("alice's message"),
    });

    expect(own.run.id).not.toBe(foreign.run.id);
    expect(own.run.threadId).toBe(ownThread.id);
  });
});

describe("durable output without a subscriber", () => {
  it("persists assistant messages and tool events with no stream open", async () => {
    const thread = await aliceRepositories.threads.createForBot(botA);
    const created = await aliceRepositories.runs.create(send(thread.id, "produce output"));
    const actor = systemActor(alice.spaceId);

    const sink = createRunEventSink(actor, db());
    await sink.append(startedEvent(1, thread.id, created.run.id));
    await sink.append(completedToolEvent(2, thread.id, created.run.id));

    const store = createAssistantMessageStore(actor, db());
    const assistant = await store.append({
      threadId: thread.id,
      runId: created.run.id,
      clientNonce: `assistant:${created.run.id}`,
      blocks: textMessageBlocks("all done"),
    });

    // Nothing above opened a subscription; both reads reconstruct the work.
    const events = await aliceRepositories.events.listAfter(thread.id, 0, 10);
    expect(events.map((row) => row.type)).toEqual(["run.started", "tool.completed"]);

    const replay = await store.append({
      threadId: thread.id,
      runId: created.run.id,
      clientNonce: `assistant:${created.run.id}`,
      blocks: textMessageBlocks("all done"),
    });
    expect(replay.id).toBe(assistant.id);

    const messages = await aliceRepositories.messages.listForThread(thread.id, {
      afterSeq: -1,
      limit: 10,
    });
    expect(messages.map((message) => message.id)).toEqual([created.message.id, assistant.id]);
    expect(messages[1]).toMatchObject({ role: "assistant", runId: created.run.id });
  });

  it("records a steer once and binds it to the run it addressed", async () => {
    const thread = await aliceRepositories.threads.createForBot(botA);
    const created = await aliceRepositories.runs.create(send(thread.id, "start"));
    const input = {
      threadId: thread.id,
      clientNonce: `steer-${randomUUID()}`,
      blocks: textMessageBlocks("change course"),
      runId: created.run.id,
    };

    const steer = await aliceRepositories.messages.steer(input);
    const replay = await aliceRepositories.messages.steer(input);

    expect(replay.id).toBe(steer.id);
    expect(steer.runId).toBe(created.run.id);

    const { rows } = await db().query<{
      readonly runId: string;
      readonly botId: string;
      readonly userId: string;
    }>(
      'select run_id as "runId", bot_id as "botId", user_id as "userId" ' +
        "from steering_message where message_id = $1",
      [steer.id],
    );

    expect(rows).toEqual([{ runId: created.run.id, botId: botA, userId: alice.userId }]);
  });
});

describe("clearing a thread", () => {
  it("empties the transcript and events but never the runs or the memory", async () => {
    const thread = await aliceRepositories.threads.createForBot(botA);
    const first = await aliceRepositories.runs.create(send(thread.id, "first"));
    await aliceRepositories.runs.create(send(thread.id, "second"));

    const actor = systemActor(alice.spaceId);
    await createRunEventSink(actor, db()).append(startedEvent(1, thread.id, first.run.id));

    const memory = createMemoryStore(alice, db());
    const written = await memory.write(botA, {
      write: {
        action: "create",
        documentId: "preferred-editor",
        kind: "preference",
        title: "Preferred editor",
        content: "The operator prefers keyboard-driven editing.",
      },
      reason: "learned during setup",
    });
    expect(written.ok).toBe(true);

    const cleared = await aliceRepositories.threads.clear(thread.id);

    expect(cleared).toMatchObject({ nextMessageSeq: 0, nextEventSeq: 0 });

    expect(
      await aliceRepositories.messages.listForThread(thread.id, { afterSeq: -1, limit: 10 }),
    ).toEqual([]);
    expect(await aliceRepositories.events.listAfter(thread.id, 0, 10)).toEqual([]);
    expect((await aliceRepositories.threads.findById(thread.id)).id).toBe(thread.id);

    // The run row survives, still pointing at its thread; only the message it
    // came from is gone, so the source link is cleared by the foreign key.
    const run = await aliceRepositories.runs.findById(first.run.id);
    expect(run.threadId).toBe(thread.id);
    expect(run.sourceMessageId).toBeNull();

    expect((await memory.list(botA)).map((document) => document.documentId)).toContain(
      "preferred-editor",
    );

    const next = await aliceRepositories.runs.create(send(thread.id, "after the clear"));
    expect(next.message.seq).toBe(0);
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
