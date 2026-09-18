import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NotFoundError } from "@porkbot/effect";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import {
  clearThread,
  createAssistantMessageStore,
  createSteeringMessageStore,
  readMessages,
} from "./messages.ts";
import type { MessageRecord, ThreadRecord } from "./records.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The message store without a server: a recording fake stands in for the pg
 * client, so what these tests prove is the commands' own contract — every
 * statement binds the actor's space, the sequence allocation and the insert
 * stay in one transaction, a unique violation replays the first row instead of
 * writing a second, and clearing resets both counters before it deletes. That
 * the statements are valid SQL, that a concurrent duplicate really collides at
 * the index and that a foreign thread is invisible is the integration suite's
 * proof.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
}

type Route = readonly [RegExp, readonly unknown[]];

function fakeDatabase(routes: readonly Route[] = []): FakeDatabase {
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

function violatingDatabase(routes: readonly Route[], pattern: RegExp): FakeDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      calls.push({ text, values });

      if (pattern.test(text)) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        });
      }

      const route = routes.find(([routePattern]) => routePattern.test(text));

      return { rows: (route?.[1] ?? []) as readonly Row[] };
    },
  };
}

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const job: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };

const message: MessageRecord = {
  id: "message-1",
  threadId: "thread-1",
  seq: 0,
  role: "assistant",
  blocks: [{ type: "text", text: "done" }],
  runId: "run-1",
  clientNonce: "assistant:message-1",
  createdAt: new Date(0),
};

const thread: ThreadRecord = {
  id: "thread-1",
  spaceId: "space-1",
  botId: "bot-1",
  userId: "user-1",
  nextEventSeq: 0,
  nextMessageSeq: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("the transcript read", () => {
  it("pages strictly after the cursor, oldest first, scoped to the actor's space", async () => {
    const database = fakeDatabase();
    const reader = readMessages(owner, database);

    await reader.listForThread("thread-1", { afterSeq: 3, limit: 10 });

    const call = database.calls[0];
    expect(call?.text).toContain("from message");
    expect(call?.text).toContain("seq > $2");
    expect(call?.text).toContain("t.space_id = $3");
    expect(call?.text).toContain("order by seq asc");
    expect(call?.values).toEqual(["thread-1", 3, "space-1", 10]);
  });

  it("looks a nonce up on one thread, inside the actor's space", async () => {
    const database = fakeDatabase([[/select .* from message/, [message]]]);
    const reader = readMessages(owner, database);

    const found = await reader.findByNonce("thread-1", "assistant:message-1");

    expect(found).toEqual(message);
    const call = database.calls[0];
    expect(call?.text).toContain("thread_id = $1");
    expect(call?.text).toContain("client_nonce = $2");
    expect(call?.text).toContain("t.space_id = $3");
    expect(call?.values).toEqual(["thread-1", "assistant:message-1", "space-1"]);
  });

  it("returns undefined when no message names the nonce", async () => {
    const reader = readMessages(owner, fakeDatabase());

    expect(await reader.findByNonce("thread-1", "missing")).toBeUndefined();
  });
});

describe("the assistant-message command", () => {
  const routes = [
    [/update thread set next_message_seq/, [{ seq: 0 }]],
    [/insert into message/, [message]],
  ] as const;

  it("allocates the position and inserts the message in one transaction, scoped to the job's space", async () => {
    const database = fakeDatabase(routes);
    const store = createAssistantMessageStore(job, database);

    const appended = await store.append({
      threadId: "thread-1",
      runId: "run-1",
      clientNonce: "assistant:message-1",
      blocks: [{ type: "text", text: "done" }],
    });

    expect(appended).toEqual(message);
    expect(database.calls.map((call) => call.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "begin",
      "update thread set",
      "insert into message",
      "commit",
    ]);

    const allocation = database.calls[1];
    expect(allocation?.text).toContain("space_id = $2");
    expect(allocation?.text).toContain("r.space_id = $2");
    expect(allocation?.values).toEqual(["thread-1", "space-1", "run-1"]);

    const insert = database.calls[2];
    expect(insert?.values).toEqual([
      "thread-1",
      0,
      "assistant",
      JSON.stringify([{ type: "text", text: "done" }]),
      "assistant:message-1",
      "run-1",
    ]);
  });

  it("replays the first row when the nonce already exists instead of inserting again", async () => {
    const database = violatingDatabase(
      [
        [/update thread set next_message_seq/, [{ seq: 0 }]],
        [/select .* from message/, [message]],
      ],
      /insert into message/,
    );
    const store = createAssistantMessageStore(job, database);

    const appended = await store.append({
      threadId: "thread-1",
      runId: "run-1",
      clientNonce: "assistant:message-1",
      blocks: [{ type: "text", text: "done" }],
    });

    expect(appended).toEqual(message);
    expect(database.calls.filter((call) => call.text === "rollback")).toHaveLength(1);
    expect(
      database.calls.some(
        (call) => call.text.startsWith("select") && call.values.includes("space-1"),
      ),
    ).toBe(true);
  });

  it("names a missing thread and a missing run differently, without writing", async () => {
    const missingThread = fakeDatabase([[/select id from thread/, []]]);
    await expect(
      createAssistantMessageStore(job, missingThread).append({
        threadId: "thread-9",
        runId: "run-1",
        clientNonce: "assistant:message-1",
        blocks: [],
      }),
    ).rejects.toMatchObject({ name: "NotFoundError", resource: "thread", id: "thread-9" });

    const missingRun = fakeDatabase([[/select id from thread/, [{ id: "thread-1" }]]]);
    await expect(
      createAssistantMessageStore(job, missingRun).append({
        threadId: "thread-1",
        runId: "run-9",
        clientNonce: "assistant:message-1",
        blocks: [],
      }),
    ).rejects.toMatchObject({ name: "NotFoundError", resource: "run", id: "run-9" });
  });
});

describe("the steering command", () => {
  it("writes the message and its delivery row in one transaction, from the thread's own bot", async () => {
    const database = fakeDatabase([
      [/update thread set next_message_seq/, [{ seq: 4, botId: "bot-1" }]],
      [/insert into message/, [{ ...message, role: "user", clientNonce: "steer-1" }]],
    ]);
    const store = createSteeringMessageStore(owner, database);

    const appended = await store.steer({
      threadId: "thread-1",
      clientNonce: "steer-1",
      blocks: [{ type: "text", text: "stop" }],
      runId: "run-1",
    });

    expect(appended).toMatchObject({ id: "message-1", seq: 0, clientNonce: "steer-1" });
    expect(database.calls.map((call) => call.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "begin",
      "update thread set",
      "insert into message",
      "insert into steering_message",
      "commit",
    ]);

    const delivery = database.calls[3];
    expect(delivery?.values).toEqual(["message-1", "bot-1", "user-1", "run-1"]);
  });

  it("replays the first message when the nonce already exists", async () => {
    const database = violatingDatabase(
      [
        [/update thread set next_message_seq/, [{ seq: 4, botId: "bot-1" }]],
        [/select .* from message/, [{ ...message, role: "user" }]],
      ],
      /insert into message/,
    );
    const store = createSteeringMessageStore(owner, database);

    const appended = await store.steer({
      threadId: "thread-1",
      clientNonce: "steer-1",
      blocks: [{ type: "text", text: "stop" }],
      runId: "run-1",
    });

    expect(appended).toMatchObject({ id: "message-1", role: "user" });
    expect(database.calls.filter((call) => call.text === "rollback")).toHaveLength(1);
  });
});

describe("clearing a thread", () => {
  it("resets both counters, then deletes the events and the messages, in one transaction", async () => {
    const database = fakeDatabase([[/update thread set/, [thread]]]);

    const cleared = await clearThread(owner, database, "thread-1");

    expect(cleared).toEqual(thread);
    expect(database.calls.map((call) => call.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "begin",
      "update thread set",
      "delete from event",
      "delete from message",
      "commit",
    ]);

    const reset = database.calls[1];
    expect(reset?.text).toContain("next_message_seq = 0");
    expect(reset?.text).toContain("next_event_seq = 0");
    expect(reset?.values).toEqual(["thread-1", "space-1"]);

    expect(database.calls[2]?.values).toEqual(["space-1", "thread-1"]);
    expect(database.calls[3]?.values).toEqual(["thread-1"]);
  });

  it("reports a thread outside the actor's space as not-found and deletes nothing", async () => {
    const database = fakeDatabase();

    await expect(clearThread(owner, database, "thread-9")).rejects.toBeInstanceOf(NotFoundError);

    expect(database.calls.some((call) => call.text.startsWith("delete"))).toBe(false);
    expect(database.calls).toContainEqual({ text: "rollback", values: [] });
  });
});

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const skippedDirectories = new Set(["dist", "node_modules", "coverage", ".turbo", ".git"]);

function shippedSourceFiles(directory: string, collected: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        shippedSourceFiles(absolute, collected);
      }

      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      collected.push(absolute);
    }
  }
}

function sourceTreeFiles(): readonly string[] {
  const collected: string[] = [];

  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      const sourceDirectory = path.join(repoRoot, group, entry.name, "src");

      if (entry.isDirectory() && existsSync(sourceDirectory)) {
        shippedSourceFiles(sourceDirectory, collected);
      }
    }
  }

  return collected.map((file) => path.relative(repoRoot, file).split(path.sep).join("/")).sort();
}

describe("the one message-writing path", () => {
  const pattern = /\binsert into (message|steering_message)\b/i;

  it("scans the shipped source tree, not an empty directory", () => {
    expect(sourceTreeFiles().length).toBeGreaterThan(50);
  });

  it("is the message store, and no other shipped source", () => {
    const offenders = sourceTreeFiles()
      .filter((file) => file !== "packages/db/src/messages.ts")
      .filter((file) => pattern.test(readFileSync(path.join(repoRoot, file), "utf8")));

    expect(
      offenders,
      "these files insert a message row; add a command to packages/db/src/messages.ts instead",
    ).toEqual([]);
  });

  it("proves the pattern fires on the statements it must catch", () => {
    for (const sample of [
      "insert into message (thread_id) values ($1)",
      "INSERT INTO steering_message (message_id) values ($1)",
    ]) {
      expect(pattern.test(sample), sample).toBe(true);
    }

    expect(pattern.test("insert into event (thread_id) values ($1)")).toBe(false);
  });
});
