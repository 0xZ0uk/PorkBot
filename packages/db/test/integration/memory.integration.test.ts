import { randomUUID } from "node:crypto";
import {
  AgentCannotDeleteMemory,
  MemoryDocumentExists,
  UnknownMemoryDocument,
} from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import type {
  MemoryDocuments,
  MemoryProposals,
  MemoryWriteInput,
  UserActor,
} from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor } from "../../src/actor.ts";
import { createMemoryStore } from "../../src/memory-store.ts";
import { createRepositories } from "../../src/repositories.ts";

/**
 * Memory durability proven where durability lives: in Postgres.
 *
 * The unit suite in `@porkbot/core` proves the write rules over a made-up
 * context; this suite composes them with the real rows and answers what only a
 * server can. A document and its revision commit together; an update adds one
 * revision and a repeated write adds none; an agent proposal is recorded as
 * such and an agent deletion is refused; a deletion leaves a tombstone revision
 * and spends the id; concurrent rewrites each get their own revision; and an
 * actor in another space can neither read nor write anything.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;
const extraClients: Client[] = [];

let user: UserActor;
let userId: string;
let botId: string;
let siblingBotId: string;
let foreignBotId: string;
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
  suite = await createSuiteDatabase({ suite: "db_memory" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  const space = await insertSpace("Memory A");
  otherSpace = await insertSpace("Memory B");
  userId = await insertUser("Alice");
  await insertMembership(space, userId, "owner");

  user = { kind: "user", spaceId: space, userId, role: "owner" };
  const repositories = createRepositories(user, db());
  botId = (
    await repositories.bots.create({ name: "Ada", color: "#4f46e5", spawnKey: randomUUID() })
  ).id;
  siblingBotId = (
    await repositories.bots.create({ name: "Bea", color: "#6366f1", spawnKey: randomUUID() })
  ).id;

  const other = createRepositories(
    { kind: "user", spaceId: otherSpace, userId, role: "owner" },
    db(),
  );
  foreignBotId = (await other.bots.create({ name: "Bo", color: "#0ea5e9", spawnKey: randomUUID() }))
    .id;
}, 180_000);

afterAll(async () => {
  await Promise.all(extraClients.map(async (extra) => extra.end()));
  await client?.end();
  await suite?.destroy();
});

function systemActor(spaceId: string): SystemActor {
  return { kind: "system", spaceId, jobId: `job-${randomUUID()}` };
}

function asOperator(actor: UserActor = user): MemoryDocuments {
  return createMemoryStore(actor, db());
}

function asAgent(actor: SystemActor = systemActor(user.spaceId)): MemoryProposals {
  return createMemoryStore(actor, db());
}

function createWrite(documentId: string, kind: "fact" | "preference" | "decision" = "fact") {
  return {
    write: {
      action: "create",
      documentId,
      kind,
      title: "Preferred editor",
      content: "The operator prefers keyboard-driven editing.",
    },
    reason: "learned during setup",
  } satisfies MemoryWriteInput;
}

function updateWrite(documentId: string, content: string): MemoryWriteInput {
  return {
    write: { action: "update", documentId, title: "Preferred editor", content },
    reason: "operator correction",
  };
}

function expectRefusal(decision: Awaited<ReturnType<MemoryDocuments["write"]>>): unknown {
  expect(decision.ok).toBe(false);

  if (decision.ok) {
    throw new Error("expected the write to be refused");
  }

  return decision.error;
}

describe("a durable memory document", () => {
  it("persists the document and one revision per effective write, with who and why", async () => {
    const documentId = `doc-${randomUUID()}`;
    const document = createWrite(documentId, "preference");

    const created = await asOperator().write(botId, document);
    expect(created).toMatchObject({
      ok: true,
      action: "create",
      revision: {
        documentId,
        revision: 1,
        origin: "deliberate",
        author: userId,
        reason: document.reason,
        kind: "preference",
        deleted: false,
      },
    });

    const found = await asOperator().find(botId, documentId);
    expect(found).toEqual({
      documentId,
      kind: "preference",
      title: "Preferred editor",
      content: "The operator prefers keyboard-driven editing.",
      revision: 1,
    });
    expect((await asOperator().list(botId)).map((entry) => entry.documentId)).toContain(documentId);

    const updated = await asOperator().write(
      botId,
      updateWrite(documentId, "Keyboard-first, no mouse."),
    );
    expect(updated).toMatchObject({ ok: true, action: "update", revision: { revision: 2 } });

    // The exact same title and content is not a change: no revision is added.
    const repeated = await asOperator().write(
      botId,
      updateWrite(documentId, "Keyboard-first, no mouse."),
    );
    expect(repeated).toEqual({ ok: true, action: "no_change" });
    expect(await asOperator().revisions(botId, documentId)).toHaveLength(2);

    // An agent's rewrite is recorded as a proposal with the bot as author.
    const proposed = await asAgent().propose(botId, updateWrite(documentId, "Vim, mostly."));
    expect(proposed).toMatchObject({
      ok: true,
      action: "update",
      revision: { revision: 3, origin: "agent_proposed", author: botId },
    });

    const history = await asOperator().revisions(botId, documentId);
    expect(history.map((revision) => revision.revision)).toEqual([1, 2, 3]);
    expect(history.map((revision) => revision.origin)).toEqual([
      "deliberate",
      "deliberate",
      "agent_proposed",
    ]);
    expect(history.map((revision) => revision.author)).toEqual([userId, userId, botId]);
    expect(history[2]?.content).toBe("Vim, mostly.");
  });

  it("refuses an agent's deletion and leaves the document live", async () => {
    const documentId = `doc-${randomUUID()}`;
    await asOperator().write(botId, createWrite(documentId));

    const refused = expectRefusal(
      await asAgent().propose(botId, {
        write: { action: "delete", documentId },
        reason: "cleaning up",
      }),
    );

    expect(refused).toBeInstanceOf(AgentCannotDeleteMemory);
    expect((await asOperator().revisions(botId, documentId)).map((r) => r.revision)).toEqual([1]);
    expect((await asOperator().find(botId, documentId)).revision).toBe(1);
  });

  it("records an operator deletion as a tombstone revision and spends the id", async () => {
    const documentId = `doc-${randomUUID()}`;
    await asOperator().write(botId, createWrite(documentId));
    await asOperator().write(botId, updateWrite(documentId, "Vim, mostly."));

    const deleted = await asOperator().write(botId, {
      write: { action: "delete", documentId },
      reason: "operator removed it",
    });

    expect(deleted).toMatchObject({
      ok: true,
      action: "delete",
      revision: { revision: 3, deleted: true, title: "Preferred editor", content: "Vim, mostly." },
    });

    await expect(asOperator().find(botId, documentId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await asOperator().list(botId)).map((entry) => entry.documentId)).not.toContain(
      documentId,
    );

    const history = await asOperator().revisions(botId, documentId);
    expect(history.at(-1)).toMatchObject({ revision: 3, deleted: true });

    // The id is spent for the document's whole life: a create collides and an
    // update has no live target.
    const recreated = expectRefusal(await asOperator().write(botId, createWrite(documentId)));
    expect(recreated).toBeInstanceOf(MemoryDocumentExists);
    const rewritten = expectRefusal(await asOperator().write(botId, updateWrite(documentId, "x")));
    expect(rewritten).toBeInstanceOf(UnknownMemoryDocument);
    expect(await asOperator().revisions(botId, documentId)).toHaveLength(3);
  });
});

describe("actor scope", () => {
  it("keeps another space from reading or writing a document", async () => {
    const documentId = `doc-${randomUUID()}`;
    await asOperator().write(botId, createWrite(documentId));

    const foreign: UserActor = { kind: "user", spaceId: otherSpace, userId, role: "owner" };

    await expect(asOperator(foreign).find(botId, documentId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await asOperator(foreign).list(botId)).toEqual([]);
    expect(await asOperator(foreign).revisions(botId, documentId)).toEqual([]);

    // A create aimed at a foreign bot inserts nothing and fails typed.
    await expect(
      asOperator(foreign).write(botId, createWrite(`doc-${randomUUID()}`)),
    ).rejects.toBeInstanceOf(NotFoundError);

    // An update has no live target in the actor's scope, so the rules refuse it.
    const rewrite = expectRefusal(
      await asOperator(foreign).write(botId, updateWrite(documentId, "tampered")),
    );
    expect(rewrite).toBeInstanceOf(UnknownMemoryDocument);

    const proposal = expectRefusal(
      await asAgent(systemActor(otherSpace)).propose(botId, updateWrite(documentId, "tampered")),
    );
    expect(proposal).toBeInstanceOf(UnknownMemoryDocument);

    const { rows } = await db().query<{ readonly count: string }>(
      "select count(*)::text as count from memory_revision where space_id = $1 and bot_id = $2",
      [otherSpace, foreignBotId],
    );
    expect(rows[0]?.count).toBe("0");
    expect((await asOperator().find(botId, documentId)).content).toBe(
      "The operator prefers keyboard-driven editing.",
    );
  });

  it("refuses a create in a space whose bot does not exist", async () => {
    const missingBot = randomUUID();
    await expect(
      asOperator().write(missingBot, createWrite(`doc-${randomUUID()}`)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps a sibling bot's documents out of reach", async () => {
    const documentId = `doc-${randomUUID()}`;
    const siblingDocumentId = `doc-${randomUUID()}`;
    await asOperator().write(botId, createWrite(documentId));

    await expect(asOperator().find(siblingBotId, documentId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await asOperator().list(siblingBotId)).toEqual([]);
    expect(await asOperator().revisions(siblingBotId, documentId)).toEqual([]);

    // The sibling can hold the same document id without colliding, and each
    // bot's listing shows only its own.
    expect((await asOperator().write(siblingBotId, createWrite(siblingDocumentId))).ok).toBe(true);
    const own = (await asOperator().list(botId)).map((doc) => doc.documentId);
    expect(own).toContain(documentId);
    expect(own).not.toContain(siblingDocumentId);
    expect((await asOperator().list(siblingBotId)).map((doc) => doc.documentId)).toEqual([
      siblingDocumentId,
    ]);

    // An agent proposing against the sibling writes its own bot's scope only.
    const proposal = await asAgent().propose(siblingBotId, updateWrite(siblingDocumentId, "x"));
    expect(proposal).toMatchObject({ ok: true, revision: { author: siblingBotId } });
  });
});

describe("concurrent writes", () => {
  it("gives every concurrent rewrite its own revision", async () => {
    const documentId = `doc-${randomUUID()}`;
    await asOperator().write(botId, createWrite(documentId));

    const writers = await Promise.all([connect(), connect(), connect(), connect()]);
    const decisions = await Promise.all(
      writers.map(async (writer, index) =>
        createMemoryStore(user, writer).write(
          botId,
          updateWrite(documentId, `concurrent rewrite ${index}`),
        ),
      ),
    );

    const revisions = decisions.map((decision) => {
      expect(decision.ok).toBe(true);

      if (!decision.ok || decision.action === "no_change") {
        throw new Error("expected an effective update");
      }

      return decision.revision.revision;
    });

    expect(new Set(revisions).size).toBe(revisions.length);
    const history = await asOperator().revisions(botId, documentId);
    expect(history.map((revision) => revision.revision)).toEqual([1, 2, 3, 4, 5]);
  });

  it("lets exactly one of several creates with the same id win", async () => {
    const documentId = `doc-${randomUUID()}`;
    const writers = await Promise.all([connect(), connect(), connect()]);
    const decisions = await Promise.all(
      writers.map(async (writer) =>
        createMemoryStore(user, writer).write(botId, createWrite(documentId)),
      ),
    );

    const created = decisions.filter((decision) => decision.ok && decision.action === "create");
    expect(created).toHaveLength(1);

    for (const decision of decisions) {
      if (!decision.ok) {
        expect(decision.error).toBeInstanceOf(MemoryDocumentExists);
      }
    }

    expect(await asOperator().revisions(botId, documentId)).toHaveLength(1);
    expect(
      (await asOperator().list(botId)).filter((doc) => doc.documentId === documentId),
    ).toHaveLength(1);
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

async function insertMembership(spaceId: string, memberId: string, role: string): Promise<void> {
  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, $3)", [
    spaceId,
    memberId,
    role,
  ]);
}

function requiredId(row: { id: string } | undefined, what: string): string {
  if (row === undefined) {
    throw new Error(`expected ${what} to insert and return its id`);
  }

  return row.id;
}
