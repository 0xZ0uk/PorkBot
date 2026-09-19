import { randomUUID } from "node:crypto";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient } from "@porkbot/contracts";
import type { Message, Thread } from "@porkbot/contracts";
import type {
  BotRecord,
  EventRecord,
  MessageRecord,
  RunRecord,
  ThreadRecord,
  UserActor,
  UserRepositories,
} from "@porkbot/db";
import type { CreatedRunAndTask, NewRunAndTask } from "@porkbot/db";
import { NotFoundError, RunNotActiveError } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceName } from "../app.ts";
import { createApiServer } from "../server.ts";

/**
 * The thread surface through the real transport: creation, the paginated list,
 * the paginated transcript, sending, steering and clearing, with the core
 * send policy deciding and the contract typing the wire.
 *
 * The repositories are an in-memory stand-in for the actor-scoped layer that
 * reproduces its rules — the space predicate, the nonce indexes' replay, the
 * sequence allocation — so what this suite proves is the behaviour an operator
 * sees: one run per send, a resubmitted nonce answered by the first result, a
 * nonce reused for other text or another thread refused as a conflict, a send
 * into a live run steered rather than started, and a cleared thread starting
 * again at sequence zero. The SQL behind the same rules is proven against
 * Postgres in `@porkbot/db`'s integration suite.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };

/**
 * The interleaving a real race produces and a single-threaded test cannot: a
 * run that is live when the send's active read sees it and finished by the
 * time the steer write runs. The fake consumes this once, inside the active
 * read, so the two repository calls observe different states of the same run.
 */
let finishRunOnNextActiveRead: string | undefined;

interface Store {
  readonly threads: Map<string, ThreadRecord>;
  readonly messages: Map<string, MessageRecord>;
  readonly runs: Map<string, RunRecord>;
  readonly events: Map<string, EventRecord>;
  readonly bots: Map<string, BotRecord>;
  readonly steering: Set<string>;
  sequence: number;
  clock: number;
}

const store: Store = {
  threads: new Map(),
  messages: new Map(),
  runs: new Map(),
  events: new Map(),
  bots: new Map(),
  steering: new Set(),
  sequence: 0,
  clock: 0,
};

function nextId(prefix: string): string {
  store.sequence += 1;
  return `${prefix}-${store.sequence}`;
}

/** A strictly increasing instant, so page order is deterministic in this fake. */
function stamp(): Date {
  store.clock += 1;
  return new Date(store.clock);
}

function seedBot(): string {
  const id = randomUUID();
  const now = stamp();

  store.bots.set(id, {
    id,
    spaceId: owner.spaceId,
    userId: owner.userId,
    name: "Ada",
    title: "",
    description: "",
    instructions: "",
    color: "#4f46e5",
    pinned: false,
    position: 0,
    sectionId: null,
    archivedAt: null,
    spawnKey: randomUUID(),
    avatarKey: null,
    computerId: null,
    modelConnectionId: null,
    model: null,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

function seedThread(botId: string, spaceId = owner.spaceId): ThreadRecord {
  const now = stamp();
  const thread: ThreadRecord = {
    id: randomUUID(),
    spaceId,
    botId,
    userId: owner.userId,
    nextEventSeq: 0,
    nextMessageSeq: 0,
    createdAt: now,
    updatedAt: now,
  };

  store.threads.set(thread.id, thread);
  return thread;
}

function scopedThread(actor: UserActor, id: string): ThreadRecord {
  const thread = store.threads.get(id);

  if (thread === undefined || thread.spaceId !== actor.spaceId) {
    throw new NotFoundError("thread", id);
  }

  return thread;
}

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the threads suite");
  };

  function activeRun(threadId: string): RunRecord | undefined {
    return [...store.runs.values()]
      .filter(
        (run) =>
          run.spaceId === actor.spaceId &&
          run.threadId === threadId &&
          run.status !== "completed" &&
          run.status !== "failed" &&
          run.status !== "cancelled",
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  }

  function createRun(input: NewRunAndTask): CreatedRunAndTask {
    const existing = [...store.runs.values()].find(
      (run) => run.spaceId === actor.spaceId && run.clientNonce === input.clientNonce,
    );

    if (existing !== undefined) {
      const replayMessage = [...store.messages.values()].find(
        (message) => message.runId === existing.id && message.clientNonce === input.clientNonce,
      );

      if (replayMessage === undefined) {
        throw new Error("the replay found no source message");
      }

      return { run: existing, task: fakeTask(existing, input), message: replayMessage };
    }

    const thread = scopedThread(actor, input.threadId);
    const runId = nextId("run");
    const now = stamp();
    const run: RunRecord = {
      id: runId,
      spaceId: actor.spaceId,
      botId: thread.botId,
      threadId: thread.id,
      taskId: nextId("task"),
      userId: actor.userId,
      status: "queued",
      trigger: "message",
      error: null,
      errorCode: null,
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      stopRequestedAt: null,
      checkpoint: {},
      clientNonce: input.clientNonce,
      sourceMessageId: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const message = appendMessage(thread, {
      role: "user",
      blocks: [...input.blocks],
      clientNonce: input.clientNonce,
      runId,
    });

    store.runs.set(runId, { ...run, sourceMessageId: message.id });
    const appended = store.threads.get(thread.id) as ThreadRecord;
    store.threads.set(thread.id, { ...appended, updatedAt: now });

    return { run: store.runs.get(runId) as RunRecord, task: fakeTask(run, input), message };
  }

  function fakeTask(run: RunRecord, input: NewRunAndTask) {
    return {
      id: run.taskId,
      spaceId: run.spaceId,
      botId: run.botId,
      threadId: run.threadId,
      userId: run.userId,
      prompt: input.prompt,
      status: "queued" as const,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  function appendMessage(
    thread: ThreadRecord,
    input: {
      readonly role: "user" | "assistant";
      readonly blocks: readonly { readonly type: "text"; readonly text: string }[];
      readonly clientNonce: string;
      readonly runId: string | null;
    },
  ): MessageRecord {
    const message: MessageRecord = {
      id: nextId("message"),
      threadId: thread.id,
      seq: thread.nextMessageSeq,
      role: input.role,
      blocks: input.blocks,
      runId: input.runId,
      clientNonce: input.clientNonce,
      createdAt: stamp(),
    };

    store.messages.set(message.id, message);
    store.threads.set(thread.id, { ...thread, nextMessageSeq: thread.nextMessageSeq + 1 });

    return message;
  }

  return {
    actor,
    membership: { requireActive: notExercised },
    bots: {
      async findById(id: string) {
        const bot = store.bots.get(id);

        if (bot === undefined || bot.spaceId !== actor.spaceId) {
          throw new NotFoundError("bot", id);
        }

        return bot;
      },
      list: notExercised,
      create: notExercised,
      update: notExercised,
      archive: notExercised,
      restore: notExercised,
      delete: notExercised,
      setAvatar: notExercised,
    },
    sections: {
      list: notExercised,
      create: notExercised,
      update: notExercised,
      delete: notExercised,
    },
    threads: {
      async findById(id: string) {
        return scopedThread(actor, id);
      },
      async listForBot(botId, page) {
        const ordered = [...store.threads.values()]
          .filter((thread) => thread.spaceId === actor.spaceId && thread.botId === botId)
          .sort((left, right) => {
            const byTime = right.updatedAt.getTime() - left.updatedAt.getTime();
            return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
          });

        const before = page.before;
        const after =
          before === undefined
            ? ordered
            : ordered.filter(
                (thread) =>
                  thread.updatedAt.getTime() < before.updatedAt.getTime() ||
                  (thread.updatedAt.getTime() === before.updatedAt.getTime() &&
                    thread.id < before.id),
              );

        return after.slice(0, page.limit);
      },
      async createForBot(botId) {
        if (botId === "bot-foreign") {
          throw new NotFoundError("bot", botId);
        }

        return seedThread(botId);
      },
      async clear(threadId) {
        const thread = scopedThread(actor, threadId);

        for (const [id, message] of store.messages) {
          if (message.threadId === threadId) {
            store.messages.delete(id);
          }
        }

        for (const [id, event] of store.events) {
          if (event.threadId === threadId) {
            store.events.delete(id);
          }
        }

        const cleared: ThreadRecord = {
          ...thread,
          nextMessageSeq: 0,
          nextEventSeq: 0,
          updatedAt: new Date(),
        };
        store.threads.set(threadId, cleared);

        return cleared;
      },
    },
    runs: {
      async findById(id) {
        const run = store.runs.get(id);

        if (run === undefined || run.spaceId !== actor.spaceId) {
          throw new NotFoundError("run", id);
        }

        return run;
      },
      async listForThread(threadId) {
        scopedThread(actor, threadId);

        return [...store.runs.values()].filter(
          (run) => run.spaceId === actor.spaceId && run.threadId === threadId,
        );
      },
      async findActiveForThread(threadId) {
        scopedThread(actor, threadId);

        const active = activeRun(threadId);

        if (active !== undefined && active.id === finishRunOnNextActiveRead) {
          finishRunOnNextActiveRead = undefined;
          store.runs.set(active.id, {
            ...active,
            status: "completed",
            completedAt: stamp(),
          });
        }

        return active;
      },
      async create(input) {
        scopedThread(actor, input.threadId);

        return createRun(input);
      },
      async requestStop(id) {
        const run = store.runs.get(id);

        if (run === undefined || run.spaceId !== actor.spaceId) {
          throw new NotFoundError("run", id);
        }

        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          return run;
        }

        const marked: RunRecord = {
          ...run,
          stopRequestedAt: run.stopRequestedAt ?? stamp(),
        };
        store.runs.set(id, marked);

        return marked;
      },
    },
    events: {
      async listAfter(threadId, afterSeq, limit) {
        scopedThread(actor, threadId);

        return [...store.events.values()]
          .filter((event) => event.threadId === threadId && event.seq > afterSeq)
          .sort((left, right) => left.seq - right.seq)
          .slice(0, limit);
      },
    },
    messages: {
      async listForThread(threadId, page) {
        scopedThread(actor, threadId);

        return [...store.messages.values()]
          .filter((message) => message.threadId === threadId && message.seq > page.afterSeq)
          .sort((left, right) => left.seq - right.seq)
          .slice(0, page.limit);
      },
      async findByNonce(threadId, clientNonce) {
        scopedThread(actor, threadId);

        return [...store.messages.values()].find(
          (message) => message.threadId === threadId && message.clientNonce === clientNonce,
        );
      },
      async steer(input) {
        const thread = scopedThread(actor, input.threadId);
        const run = store.runs.get(input.runId);

        if (run === undefined || run.spaceId !== actor.spaceId || run.threadId !== thread.id) {
          throw new NotFoundError("run", input.runId);
        }

        // The live-run guard the SQL enforces with the state machine's active
        // set: a run that finished between the send's read and this write is
        // refused, never silently appended to.
        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          throw new RunNotActiveError(input.runId, run.status);
        }

        const existing = [...store.messages.values()].find(
          (message) => message.threadId === thread.id && message.clientNonce === input.clientNonce,
        );

        if (existing !== undefined) {
          return existing;
        }

        const message = appendMessage(thread, {
          role: "user",
          blocks: [...input.blocks],
          clientNonce: input.clientNonce,
          runId: input.runId,
        });

        store.steering.add(message.id);

        return message;
      },
    },
    notifications: {
      read: notExercised,
      set: notExercised,
    },
    routines: {
      findById: notExercised,
      list: notExercised,
      listForBot: notExercised,
      outcomes: notExercised,
      lastOutcome: notExercised,
      preview: notExercised,
      create: notExercised,
      update: notExercised,
      remove: notExercised,
      testRun: notExercised,
    },
    credentials: {
      resolve: notExercised,
      list: notExercised,
      store: notExercised,
      rotate: notExercised,
      remove: notExercised,
    },
    mcp: {
      list: notExercised,
      findById: notExercised,
      create: notExercised,
      setStatus: notExercised,
      replaceTools: notExercised,
      remove: notExercised,
      grant: notExercised,
      revoke: notExercised,
      listForServer: notExercised,
    },
    modelConnections: {
      findById: notExercised,
      list: notExercised,
      create: notExercised,
      update: notExercised,
      setDefault: notExercised,
      delete: notExercised,
    },
  };
}

const server = createApiServer({
  services: {
    deployment: {
      async status() {
        return { kind: "closed" };
      },
    },
    realtime: new InProcessRealtimeFanout(),
  },
  logger: createLogger({ service: serviceName, write: () => undefined }),
  resolveActor: async () => owner,
  repositoriesFor,
});

let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  baseUrl = `http://127.0.0.1:${address.port}/rpc`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function client() {
  return createApiClient({ url: baseUrl });
}

describe("thread creation and listing", () => {
  it("creates a thread for one bot and pages the bot's threads by activity", async () => {
    const api = client();
    const botId = seedBot();

    const first = await api.threads.create({ botId });
    await api.threads.send({ threadId: first.id, text: "hello", clientNonce: randomUUID() });

    const second = await api.threads.create({ botId });
    await api.threads.send({ threadId: second.id, text: "newer", clientNonce: randomUUID() });

    const page = await api.threads.list({ botId, limit: 1 });

    expect(page.threads.map((thread) => thread.id)).toEqual([second.id]);
    expect(page.nextCursor).not.toBeNull();

    if (page.nextCursor === null) {
      throw new Error("expected a next cursor");
    }

    const rest = await api.threads.list({ botId, limit: 1, after: page.nextCursor });

    expect(rest.threads.map((thread) => thread.id)).toEqual([first.id]);
    expect(rest.nextCursor).toBeNull();
  });

  it("refuses a bot outside the actor's space", async () => {
    await expect(client().threads.create({ botId: "bot-foreign" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client().threads.list({ botId: "bot-foreign" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("sending a message", () => {
  it("creates exactly one run and replays it for a resubmitted nonce", async () => {
    const api = client();
    const thread = seedThread(seedBot());
    const clientNonce = randomUUID();

    const sent = await api.threads.send({ threadId: thread.id, text: "do it", clientNonce });
    const resent = await api.threads.send({ threadId: thread.id, text: "do it", clientNonce });

    expect(sent.action).toBe("start_run");
    expect(resent.action).toBe("replay");
    expect(resent.message.id).toBe(sent.message.id);
    expect(resent.runId).toBe(sent.runId);

    const runs = [...store.runs.values()].filter((run) => run.threadId === thread.id);
    expect(runs).toHaveLength(1);
  });

  it("refuses a nonce reused for different text", async () => {
    const api = client();
    const thread = seedThread(seedBot());
    const clientNonce = randomUUID();

    const sent = await api.threads.send({ threadId: thread.id, text: "first", clientNonce });

    await expect(
      api.threads.send({ threadId: thread.id, text: "second", clientNonce }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(
      [...store.messages.values()].filter((message) => message.threadId === thread.id),
    ).toHaveLength(1);
    expect(sent.message.id).toBeDefined();
  });

  it("refuses a nonce already spent on a different thread", async () => {
    const api = client();
    const botId = seedBot();
    const first = seedThread(botId);
    const second = seedThread(botId);
    const clientNonce = randomUUID();

    await api.threads.send({ threadId: first.id, text: "first", clientNonce });

    await expect(
      api.threads.send({ threadId: second.id, text: "second", clientNonce }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses blank text even though the schema only demands one character", async () => {
    const thread = seedThread(seedBot());

    await expect(
      client().threads.send({ threadId: thread.id, text: "   ", clientNonce: randomUUID() }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("steers the thread's live run instead of starting a second one", async () => {
    const api = client();
    const thread = seedThread(seedBot());
    const nonce = randomUUID();

    const started = await api.threads.send({
      threadId: thread.id,
      text: "start",
      clientNonce: randomUUID(),
    });

    const steered = await api.threads.send({
      threadId: thread.id,
      text: "change course",
      clientNonce: nonce,
    });

    expect(steered.action).toBe("steer");
    expect(steered.runId).toBe(started.runId);
    expect(store.steering.has(steered.message.id)).toBe(true);

    expect([...store.runs.values()].filter((run) => run.threadId === thread.id)).toHaveLength(1);

    const replayed = await api.threads.send({
      threadId: thread.id,
      text: "change course",
      clientNonce: nonce,
    });

    expect(replayed.action).toBe("replay");
    expect(replayed.message.id).toBe(steered.message.id);
    expect([...store.runs.values()].filter((run) => run.threadId === thread.id)).toHaveLength(1);
  });

  it("refuses a steer that raced the run's finish, instead of starting a second run", async () => {
    const api = client();
    const thread = seedThread(seedBot());

    const started = await api.threads.send({
      threadId: thread.id,
      text: "start",
      clientNonce: randomUUID(),
    });

    finishRunOnNextActiveRead = started.runId ?? "";

    const refused = await api.threads
      .send({ threadId: thread.id, text: "change course", clientNonce: randomUUID() })
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: "PRECONDITION_FAILED" });

    const runs = [...store.runs.values()].filter((run) => run.threadId === thread.id);
    expect(runs).toHaveLength(1);
    expect(
      [...store.messages.values()].filter((message) => message.threadId === thread.id),
    ).toHaveLength(1);
  });
});

describe("the transcript and clearing", () => {
  it("pages messages by sequence and starts again from zero after a clear", async () => {
    const api = client();
    const thread = seedThread(seedBot());

    for (const text of ["one", "two", "three"]) {
      await api.threads.send({ threadId: thread.id, text, clientNonce: randomUUID() });
    }

    const page = await api.threads.messages({ threadId: thread.id, limit: 2 });
    expect(page.messages.map((message: Message) => message.seq)).toEqual([0, 1]);
    expect(page.nextSeq).toBe(1);

    const rest = await api.threads.messages({
      threadId: thread.id,
      limit: 2,
      afterSeq: page.nextSeq ?? 0,
    });
    expect(rest.messages.map((message: Message) => message.seq)).toEqual([2]);
    expect(rest.nextSeq).toBeNull();

    const cleared = await api.threads.clear({ threadId: thread.id });
    expect(cleared.id).toBe(thread.id);

    const empty = await api.threads.messages({ threadId: thread.id });
    expect(empty.messages).toEqual([]);
    expect(empty.nextSeq).toBeNull();

    const after = await api.threads.send({
      threadId: thread.id,
      text: "again",
      clientNonce: randomUUID(),
    });
    expect(after.message.seq).toBe(0);
  });

  it("answers a foreign thread as not-found for every procedure", async () => {
    const api = client();
    const foreign = seedThread(seedBot(), "space-2");

    await expect(api.threads.messages({ threadId: foreign.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.threads.clear({ threadId: foreign.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      api.threads.send({ threadId: foreign.id, text: "hello", clientNonce: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the wire shape", () => {
  it("returns the contract's thread and message types, never the row's", async () => {
    const api = client();
    const botId = seedBot();
    const thread: Thread = await api.threads.create({ botId });
    const sent = await api.threads.send({
      threadId: thread.id,
      text: "hello",
      clientNonce: randomUUID(),
    });

    expect(Object.keys(thread).sort()).toEqual(["botId", "createdAt", "id", "updatedAt"]);
    expect(sent.message).toMatchObject({
      threadId: thread.id,
      seq: 0,
      role: "user",
      blocks: [{ type: "text", text: "hello" }],
      runId: sent.runId,
    });
  });
});
