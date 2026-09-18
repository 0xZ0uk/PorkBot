import {
  AgentCannotDeleteMemory,
  EmptyMemoryTitle,
  MemoryDocumentExists,
  MemoryDocumentLimitReached,
  MissingMemoryReason,
  UnknownMemoryDocument,
} from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { createMemoryStore } from "./memory-store.ts";

/**
 * The memory store without a server: a recording fake stands in for the pg
 * client, so these tests prove the module's own contract — every statement
 * binds the actor's space and the bot, a change and its revision are one CTE
 * statement, the revision number is allocated by the database rather than the
 * pre-read, an agent proposal is recorded with the bot as author and can never
 * delete, and a refused decision issues no write at all.
 *
 * Whether concurrent writers really each get a revision is not provable here;
 * the integration suite runs the same calls against Postgres.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
}

function fakeDatabase(respond: (call: QueryCall) => readonly unknown[] = () => []): FakeDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      const call = { text, values };
      calls.push(call);

      return { rows: respond(call) as readonly Row[] };
    },
  };
}

const worker: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };
const operator: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };

function documentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentId: "doc-1",
    kind: "fact",
    title: "Preferred editor",
    content: "The operator prefers keyboard-driven editing.",
    revision: 1,
    ...overrides,
  };
}

function revisionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...documentRow(),
    origin: "deliberate",
    author: "user-1",
    reason: "operator correction",
    deleted: false,
    ...overrides,
  };
}

const isDocumentRead = (text: string): boolean =>
  text.startsWith('select document_id as "documentId"') && text.includes("from memory_document");
const isCount = (text: string): boolean => text.startsWith("select count(*)::int");
const isRevisionRead = (text: string): boolean => text.includes("from memory_revision");
const isCreate = (text: string): boolean => text.startsWith("with inserted as");
const isUpdate = (text: string): boolean => text.startsWith("with updated as");
const isDelete = (text: string): boolean => text.startsWith("with removed as");
const isBotRead = (text: string): boolean => text.startsWith("select id from bot");

const callsMatching = (
  calls: readonly QueryCall[],
  predicate: (text: string) => boolean,
): readonly QueryCall[] => calls.filter(({ text }) => predicate(text));

const writes = (calls: readonly QueryCall[]): readonly QueryCall[] =>
  calls.filter(({ text }) => isCreate(text) || isUpdate(text) || isDelete(text));

const createInput = {
  write: {
    action: "create",
    documentId: "doc-1",
    kind: "fact",
    title: "Preferred editor",
    content: "The operator prefers keyboard-driven editing.",
  },
  reason: "learned during setup",
} as const;

describe("creating a document", () => {
  it("inserts the document and its first revision in one scoped statement", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isCount(text)) {
        return []; // no count row is the empty count
      }

      return isCreate(text) ? [revisionRow({ reason: "learned during setup" })] : [];
    });

    const decision = await createMemoryStore(operator, database).write("bot-1", createInput);

    expect(decision).toMatchObject({
      ok: true,
      action: "create",
      revision: { documentId: "doc-1", revision: 1, origin: "deliberate", author: "user-1" },
    });

    const [create] = callsMatching(database.calls, isCreate);
    expect(create?.text).toContain("on conflict (bot_id, document_id) do nothing");
    expect(create?.text).toContain("from bot b where b.id = $2 and b.space_id = $1");
    expect(create?.text).toContain("i.kind, i.title, i.content, false from inserted i");
    expect(create?.values).toEqual([
      "space-1",
      "bot-1",
      "doc-1",
      "fact",
      "Preferred editor",
      "The operator prefers keyboard-driven editing.",
      "deliberate",
      "user-1",
      "learned during setup",
    ]);
  });

  it("refuses an id that is already spent, as the conflict clause proves", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isBotRead(text)) {
        return [{ id: "bot-1" }];
      }

      return [];
    });

    const decision = await createMemoryStore(operator, database).write("bot-1", createInput);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBeInstanceOf(MemoryDocumentExists);
    }
    expect(callsMatching(database.calls, isBotRead)).toHaveLength(1);
  });

  it("fails typed for a bot outside the actor's space and writes nothing", async () => {
    const database = fakeDatabase(() => []);

    await expect(
      createMemoryStore(operator, database).write("bot-1", createInput),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(writes(database.calls)).toHaveLength(1); // the no-op insert; no revision followed
  });

  it("stores an agent proposal as agent_proposed with the bot as author", async () => {
    const database = fakeDatabase(({ text }) =>
      isCreate(text) ? [revisionRow({ origin: "agent_proposed", author: "bot-1" })] : [],
    );

    const decision = await createMemoryStore(worker, database).propose("bot-1", createInput);

    expect(decision).toMatchObject({
      ok: true,
      action: "create",
      revision: { origin: "agent_proposed", author: "bot-1" },
    });
    expect(callsMatching(database.calls, isCreate)[0]?.values[6]).toBe("agent_proposed");
  });

  it("refuses to grow past the per-bot limit without issuing a write", async () => {
    const database = fakeDatabase(({ text }) => (isCount(text) ? [{ count: 200 }] : []));

    const decision = await createMemoryStore(operator, database).write("bot-1", createInput);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBeInstanceOf(MemoryDocumentLimitReached);
    }
    expect(writes(database.calls)).toHaveLength(0);
  });
});

describe("rewriting a document", () => {
  const updateInput = {
    write: { action: "update", documentId: "doc-1", title: "Editor", content: "Vim, mostly." },
    reason: "operator correction",
  } as const;

  const found = (text: string): readonly unknown[] => {
    if (isDocumentRead(text)) {
      return [documentRow()];
    }

    if (isCount(text)) {
      return [{ count: 1 }];
    }

    return [];
  };

  it("allocates the revision in the update statement and records who and why", async () => {
    const database = fakeDatabase(({ text }) =>
      isUpdate(text)
        ? [revisionRow({ revision: 2, title: "Editor", content: "Vim, mostly." })]
        : found(text),
    );

    const decision = await createMemoryStore(operator, database).write("bot-1", updateInput);

    expect(decision).toMatchObject({
      ok: true,
      action: "update",
      revision: { revision: 2, author: "user-1", reason: "operator correction" },
    });

    const [update] = callsMatching(database.calls, isUpdate);
    expect(update?.text).toContain("revision = revision + 1");
    expect(update?.text).toContain("and deleted_at is null");
    expect(update?.values).toEqual([
      "space-1",
      "bot-1",
      "doc-1",
      "Editor",
      "Vim, mostly.",
      "deliberate",
      "user-1",
      "operator correction",
    ]);
  });

  it("persists nothing when the write repeats the document's exact state", async () => {
    const database = fakeDatabase(({ text }) =>
      isCount(text) ? [{ count: 1 }] : isDocumentRead(text) ? [documentRow()] : [],
    );

    const decision = await createMemoryStore(operator, database).write("bot-1", {
      write: {
        action: "update",
        documentId: "doc-1",
        title: "Preferred editor",
        content: "The operator prefers keyboard-driven editing.",
      },
      reason: "operator correction",
    });

    expect(decision).toEqual({ ok: true, action: "no_change" });
    expect(writes(database.calls)).toHaveLength(0);
  });

  it("answers unknown-document when the guarded update matches no row", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isDocumentRead(text)) {
        return [documentRow()];
      }

      if (isCount(text)) {
        return [{ count: 1 }];
      }

      return []; // The update CTE matched nothing: another writer got there first.
    });

    const decision = await createMemoryStore(operator, database).write("bot-1", updateInput);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBeInstanceOf(UnknownMemoryDocument);
    }
    expect(callsMatching(database.calls, isUpdate)).toHaveLength(1);
  });
});

describe("deleting a document", () => {
  const deleteInput = {
    write: { action: "delete", documentId: "doc-1" },
    reason: "operator removed it",
  } as const;

  it("tombstones the live row and appends the revision that deleted it", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isDocumentRead(text)) {
        return [documentRow()];
      }

      if (isCount(text)) {
        return [{ count: 1 }];
      }

      return isDelete(text)
        ? [revisionRow({ revision: 2, deleted: true, reason: "operator removed it" })]
        : [];
    });

    const decision = await createMemoryStore(operator, database).write("bot-1", deleteInput);

    expect(decision).toMatchObject({
      ok: true,
      action: "delete",
      revision: { revision: 2, deleted: true, title: "Preferred editor" },
    });

    const [remove] = callsMatching(database.calls, isDelete);
    expect(remove?.text).toContain("deleted_at = now()");
    expect(remove?.text).toContain("true from removed r");
    expect(remove?.values).toEqual([
      "space-1",
      "bot-1",
      "doc-1",
      "deliberate",
      "user-1",
      "operator removed it",
    ]);
  });

  it("refuses an agent deletion as a rule, before any write", async () => {
    const database = fakeDatabase(({ text }) =>
      isDocumentRead(text) ? [documentRow()] : isCount(text) ? [{ count: 1 }] : [],
    );

    const decision = await createMemoryStore(worker, database).propose("bot-1", deleteInput);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBeInstanceOf(AgentCannotDeleteMemory);
    }
    expect(writes(database.calls)).toHaveLength(0);
  });

  it("answers unknown-document when another writer tombstoned it first", async () => {
    const database = fakeDatabase(({ text }) =>
      isDocumentRead(text) ? [documentRow()] : isCount(text) ? [{ count: 1 }] : [],
    );

    const decision = await createMemoryStore(operator, database).write("bot-1", deleteInput);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBeInstanceOf(UnknownMemoryDocument);
    }
  });
});

describe("validation before storage", () => {
  it("refuses a blank reason without issuing a write", async () => {
    const database = fakeDatabase(({ text }) =>
      isDocumentRead(text) ? [documentRow()] : isCount(text) ? [{ count: 1 }] : [],
    );

    const decision = await createMemoryStore(operator, database).write("bot-1", {
      write: { action: "update", documentId: "doc-1", title: "Editor", content: "Vim." },
      reason: "   ",
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBeInstanceOf(MissingMemoryReason);
    }
    expect(writes(database.calls)).toHaveLength(0);
  });

  it("refuses a blank title without issuing a write", async () => {
    const database = fakeDatabase(() => []);

    const decision = await createMemoryStore(operator, database).write("bot-1", {
      write: {
        action: "create",
        documentId: "doc-1",
        kind: "fact",
        title: " ",
        content: "content",
      },
      reason: "why",
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toBeInstanceOf(EmptyMemoryTitle);
    }
    expect(writes(database.calls)).toHaveLength(0);
  });
});

describe("the scoped reads", () => {
  it("finds a live document inside the actor's space and never a tombstone", async () => {
    const database = fakeDatabase(({ text }) => (isDocumentRead(text) ? [documentRow()] : []));
    const store = createMemoryStore(operator, database);

    expect(await store.find("bot-1", "doc-1")).toEqual(documentRow());
    expect(database.calls[0]?.text).toContain("deleted_at is null");
    expect(database.calls[0]?.values).toEqual(["space-1", "bot-1", "doc-1"]);
  });

  it("throws the shared not-found for an id outside the actor's scope", async () => {
    const store = createMemoryStore(operator, fakeDatabase());

    await expect(store.find("bot-1", "doc-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists live documents oldest first, scoped to the bot", async () => {
    const database = fakeDatabase(({ text }) =>
      isDocumentRead(text) && !isRevisionRead(text) ? [documentRow()] : [],
    );
    const store = createMemoryStore(worker, database);

    expect(await store.list("bot-1")).toEqual([documentRow()]);
    expect(database.calls[0]?.text).toContain("deleted_at is null");
    expect(database.calls[0]?.text).toContain("order by created_at asc, id asc");
    expect(database.calls[0]?.values).toEqual(["space-1", "bot-1"]);
  });

  it("reads the whole revision history, tombstone included, oldest first", async () => {
    const database = fakeDatabase(({ text }) =>
      isRevisionRead(text)
        ? [revisionRow(), revisionRow({ revision: 2, deleted: true, origin: "agent_proposed" })]
        : [],
    );
    const store = createMemoryStore(operator, database);

    const history = await store.revisions("bot-1", "doc-1");

    expect(history.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(history[1]?.deleted).toBe(true);
    expect(database.calls[0]?.text).toContain("order by revision asc");
    expect(database.calls[0]?.values).toEqual(["space-1", "bot-1", "doc-1"]);
  });
});

describe("the actor's half of the seam", () => {
  it("gives the operator no proposal path and the job no deliberate write", () => {
    const system = createMemoryStore(worker, fakeDatabase());
    const user = createMemoryStore(operator, fakeDatabase());

    // @ts-expect-error -- proposing is the agent's write, not the operator's.
    expect(system.write).toBeUndefined();
    // @ts-expect-error -- a deliberate write is the operator's, not a job's.
    expect(user.propose).toBeUndefined();
    // @ts-expect-error -- revision history is the operator's read.
    expect(system.revisions).toBeUndefined();
  });
});
