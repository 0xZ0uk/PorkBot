import { NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import type { BotRecord, SystemRepositories } from "./repositories.ts";
import { createRepositories } from "./repositories.ts";

/**
 * The repository layer without a server: a recording fake stands in for the pg
 * client, so what these tests prove is the layer's own contract — every
 * statement binds the actor's space, a missing row and an out-of-space row are
 * the same not-found, and the defaults the schema would apply are supplied
 * explicitly. Whether the SQL is *valid against Postgres* is not provable here;
 * the integration suite runs the same calls on the real thing.
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

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const worker: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };

const bot: BotRecord = {
  id: "bot-1",
  spaceId: "space-1",
  userId: "user-1",
  name: "Ada",
  title: "",
  description: "",
  instructions: "",
  color: "#000000",
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  spawnKey: "spawn-1",
  avatarKey: null,
  computerId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/**
 * The calls below are deliberately wrong and are never invoked. They exist so
 * `tsc` fails if the factory ever grows a call shape that takes a database, a
 * space id or a user id instead of an actor.
 */
function rejectedConstruction(database: Queryable): readonly (() => unknown)[] {
  return [
    // @ts-expect-error -- a database is not a scope; an Actor is required.
    () => createRepositories(database),
    // @ts-expect-error -- a raw tenant id is not an Actor.
    () => createRepositories({ spaceId: "space-1", userId: "user-1" }, database),
  ];
}

/**
 * The run-creation command carries a user of record, so it does not exist on a
 * job's read-only scope; the directive below is the proof, and this helper is
 * where the compiler checks it.
 */
function rejectedRunCreation(repositories: SystemRepositories): Promise<unknown> {
  // @ts-expect-error -- `create` exists on the user scope, not on a job's reads.
  return repositories.runs.create({
    threadId: "thread-1",
    clientNonce: "nonce-1",
    prompt: "do the thing",
    blocks: [],
  });
}

/** The same proof for a system actor: this slice gives a job reads, no writes. */
function rejectedSystemWrites(repositories: SystemRepositories): readonly (() => unknown)[] {
  return [
    // @ts-expect-error -- a job has no user to attribute a bot to.
    () => repositories.bots.create({ name: "Ada", color: "#000000", spawnKey: "spawn-1" }),
    // @ts-expect-error -- a job cannot update a user-owned bot in this slice.
    () => repositories.bots.update("bot-1", { name: "Grace" }),
    // @ts-expect-error -- a job cannot archive, restore or delete a user's bot.
    () => repositories.bots.delete("bot-1"),
    // @ts-expect-error -- restoring is the operator's act, not a job's.
    () => repositories.bots.restore("bot-1"),
    // @ts-expect-error -- a job cannot create a thread; it has no user of record.
    () => repositories.threads.createForBot("bot-1"),
    // @ts-expect-error -- sections are an operator surface; a job reads none.
    () => repositories.sections.list(),
    () => rejectedRunCreation(repositories),
  ];
}

describe("scoping statements to the actor's space", () => {
  it("binds every read to the actor's space, never to a caller argument", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.findById("bot-1");
    await repositories.bots.list();
    await repositories.threads.findById("thread-1");
    await repositories.threads.listForBot("bot-1");
    await repositories.runs.findById("run-1");
    await repositories.runs.listForThread("thread-1");
    await repositories.events.listAfter("thread-1", 3, 10);

    expect(database.calls).toHaveLength(7);

    for (const call of database.calls) {
      expect(call.text).toContain("space_id");
      expect(call.values).toContain(owner.spaceId);
    }
  });

  it("binds every write to the actor's space and the actor's user", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.create({ name: "Ada", color: "#000000", spawnKey: "spawn-1" });
    await repositories.bots.update("bot-1", { name: "Grace" });
    await repositories.threads.createForBot("bot-1");

    expect(database.calls).toHaveLength(3);

    for (const call of database.calls) {
      expect(call.text).toContain("space_id");
      expect(call.values).toContain(owner.spaceId);
    }

    expect(database.calls[0]?.values).toContain(owner.userId);
    expect(database.calls[2]?.values).toContain(owner.userId);
  });
});

describe("the event replay read", () => {
  it("reads strictly after the cursor, oldest first, scoped to the actor's space", async () => {
    const database = fakeDatabase();
    const repositories = createRepositories(owner, database);

    await repositories.events.listAfter("thread-1", 3, 10);

    const call = database.calls[0];

    expect(call?.text).toContain("from event");
    expect(call?.text).toContain("space_id = $1");
    expect(call?.text).toContain("thread_id = $2");
    expect(call?.text).toContain("seq > $3");
    expect(call?.text).toContain("order by seq asc");
    expect(call?.values).toEqual(["space-1", "thread-1", 3, 10]);
  });
});

describe("not-found semantics", () => {
  it("throws NotFoundError when a scoped read matches no row", async () => {
    const repositories = createRepositories(owner, fakeDatabase());

    await expect(repositories.bots.findById("bot-1")).rejects.toMatchObject({
      name: "NotFoundError",
      resource: "bot",
      id: "bot-1",
    });
    await expect(repositories.threads.findById("thread-1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(repositories.runs.findById("run-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws the same error for a missing row and an out-of-space row", async () => {
    const database = fakeDatabase(() => []);
    const missing = createRepositories(owner, database);
    const otherSpace = createRepositories(
      { kind: "user", spaceId: "space-2", userId: "user-2", role: "member" },
      database,
    );

    const missingError = await missing.bots.findById("bot-1").catch((error: unknown) => error);
    const outOfScopeError = await otherSpace.bots
      .findById("bot-1")
      .catch((error: unknown) => error);

    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(outOfScopeError).toBeInstanceOf(NotFoundError);
    expect((missingError as Error).message).toBe((outOfScopeError as Error).message);
  });

  it("throws NotFoundError when a scoped write matches no row", async () => {
    const repositories = createRepositories(owner, fakeDatabase());

    await expect(repositories.bots.update("bot-1", { name: "Grace" })).rejects.toMatchObject({
      resource: "bot",
      id: "bot-1",
    });
    await expect(repositories.threads.createForBot("bot-9")).rejects.toMatchObject({
      resource: "bot",
      id: "bot-9",
    });
  });
});

describe("bot writes", () => {
  it("creates a bot from the actor, writing the schema defaults explicitly", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.create({ name: "Ada", color: "#4f46e5", spawnKey: "spawn-1" });

    expect(database.calls[0]?.text).toContain("insert into bot");
    expect(database.calls[0]?.text).toContain(
      "on conflict (space_id, spawn_key) do update set spawn_key = excluded.spawn_key",
    );
    expect(database.calls[0]?.values).toEqual([
      "space-1",
      "user-1",
      "Ada",
      "",
      "",
      "",
      "#4f46e5",
      false,
      0,
      null,
      "spawn-1",
      null,
    ]);
  });

  it("resolves the section inside the scoped insert, never with a raw id write", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.create({
      name: "Ada",
      color: "#4f46e5",
      spawnKey: "spawn-1",
      sectionId: "section-1",
      computerId: "computer-1",
    });

    expect(database.calls[0]?.text).toContain(
      "left join bot_section s on s.id = $12::uuid and s.space_id = $1 and s.user_id = $2",
    );
    expect(database.calls[0]?.values).toEqual([
      "space-1",
      "user-1",
      "Ada",
      "",
      "",
      "",
      "#4f46e5",
      false,
      0,
      "computer-1",
      "spawn-1",
      "section-1",
    ]);
  });

  it("reports a section outside the actor's space as not-found, with nothing inserted", async () => {
    const database = fakeDatabase(() => []);
    const repositories = createRepositories(owner, database);

    await expect(
      repositories.bots.create({
        name: "Ada",
        color: "#4f46e5",
        spawnKey: "spawn-1",
        sectionId: "section-9",
      }),
    ).rejects.toMatchObject({ name: "NotFoundError", resource: "bot section", id: "section-9" });
  });

  it("updates only the fields the patch names", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.update("bot-1", { name: "Grace" });

    expect(database.calls[0]?.text).toContain("updated_at = now()");
    expect(database.calls[0]?.text).toContain("name = $1");
    expect(database.calls[0]?.text).toContain("where id = $2 and space_id = $3");
    expect(database.calls[0]?.values).toEqual(["Grace", "bot-1", "space-1"]);
  });

  it("updates every mutable field when the patch names them all", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.update("bot-1", {
      name: "Grace",
      title: "Rear Admiral",
      description: "compiler",
      instructions: "be helpful",
      color: "#000000",
      pinned: true,
      position: 4,
    });

    expect(database.calls[0]?.text).toContain("description = $3");
    expect(database.calls[0]?.values).toEqual([
      "Grace",
      "Rear Admiral",
      "compiler",
      "be helpful",
      "#000000",
      true,
      4,
      "bot-1",
      "space-1",
    ]);
  });

  it("touches only updated_at when the patch names no fields", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.update("bot-1", {});

    expect(database.calls[0]?.text).toContain("set updated_at = now() where id = $1");
    expect(database.calls[0]?.values).toEqual(["bot-1", "space-1"]);
  });

  it("guards a section patch inside the same scoped update", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.update("bot-1", { sectionId: "section-1", computerId: "computer-1" });

    expect(database.calls[0]?.text).toContain("section_id = $1");
    expect(database.calls[0]?.text).toContain("computer_id = $2");
    expect(database.calls[0]?.text).toContain("exists (select 1 from bot_section s");
    expect(database.calls[0]?.values).toEqual([
      "section-1",
      "computer-1",
      "bot-1",
      "space-1",
      "user-1",
    ]);
  });

  it("separates a missing section from a missing bot on an empty update", async () => {
    const database = fakeDatabase(() => []);
    const repositories = createRepositories(owner, database);

    await expect(
      repositories.bots.update("bot-1", { sectionId: "section-9" }),
    ).rejects.toMatchObject({ resource: "bot section", id: "section-9" });
  });

  it("clears a section with a null that the guard accepts", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.update("bot-1", { sectionId: null });

    expect(database.calls[0]?.text).toContain("$1::uuid is null or exists");
    expect(database.calls[0]?.values).toEqual([null, "bot-1", "space-1", "user-1"]);
  });

  it("treats an empty insert result as a fault, not a missing row", async () => {
    const repositories = createRepositories(owner, fakeDatabase());

    await expect(
      repositories.bots.create({ name: "Ada", color: "#000000", spawnKey: "spawn-1" }),
    ).rejects.toThrow("the database returned no row for an insert");
  });

  it("archives idempotently, keeps the first instant and binds the actor's space", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.archive("bot-1");

    expect(database.calls[0]?.text).toContain("archived_at = coalesce(archived_at, now())");
    expect(database.calls[0]?.values).toEqual(["bot-1", "space-1"]);
  });

  it("restores by clearing the archived instant and binds the actor's space", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.restore("bot-1");

    expect(database.calls[0]?.text).toContain("archived_at = null");
    expect(database.calls[0]?.values).toEqual(["bot-1", "space-1"]);
  });

  it("deletes by id inside the actor's space and returns the removed row", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    const removed = await repositories.bots.delete("bot-1");

    expect(database.calls[0]?.text).toContain("delete from bot where id = $1 and space_id = $2");
    expect(removed.id).toBe("bot-1");
  });

  it("sets and clears the avatar key through the scoped update", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.setAvatar("bot-1", "avatars/space-1/bot-1");
    await repositories.bots.setAvatar("bot-1", null);

    expect(database.calls[0]?.text).toContain("avatar_key = $1");
    expect(database.calls[0]?.values).toEqual(["avatars/space-1/bot-1", "bot-1", "space-1"]);
    expect(database.calls[1]?.values).toEqual([null, "bot-1", "space-1"]);
  });
});

describe("the bot list's archived scopes", () => {
  it("excludes archived bots by default and by the active scope", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.list();
    await repositories.bots.list("active");

    for (const call of database.calls) {
      expect(call.text).toContain("archived_at is null");
      expect(call.values).toEqual(["space-1"]);
    }
  });

  it("lists only archived bots for the restore screen, and both for all", async () => {
    const database = fakeDatabase(() => [bot]);
    const repositories = createRepositories(owner, database);

    await repositories.bots.list("archived");
    await repositories.bots.list("all");

    expect(database.calls[0]?.text).toContain("archived_at is not null");
    expect(database.calls[1]?.text).not.toContain("archived_at is");
    expect(database.calls[1]?.values).toEqual(["space-1"]);
  });
});

describe("bot sections", () => {
  const section = {
    id: "section-1",
    spaceId: "space-1",
    userId: "user-1",
    name: "Research",
    position: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it("lists the actor's sections in position order", async () => {
    const database = fakeDatabase(() => [section]);
    const repositories = createRepositories(owner, database);

    await repositories.sections.list();

    expect(database.calls[0]?.text).toContain(
      "from bot_section where space_id = $1 and user_id = $2",
    );
    expect(database.calls[0]?.text).toContain("order by position asc");
    expect(database.calls[0]?.values).toEqual(["space-1", "user-1"]);
  });

  it("creates a section under the actor's space and user, refusing a taken name", async () => {
    const database = fakeDatabase(() => []);
    const repositories = createRepositories(owner, database);

    await expect(repositories.sections.create({ name: "Research" })).rejects.toMatchObject({
      _tag: "NameConflictError",
      resource: "bot section",
      name: "Research",
    });

    expect(database.calls[0]?.text).toContain("on conflict (space_id, user_id, name) do nothing");
    expect(database.calls[0]?.values).toEqual(["space-1", "user-1", "Research", 0]);
  });

  it("creates with the position the caller names", async () => {
    const database = fakeDatabase(() => [section]);
    const repositories = createRepositories(owner, database);

    await repositories.sections.create({ name: "Research", position: 3 });

    expect(database.calls[0]?.values).toEqual(["space-1", "user-1", "Research", 3]);
  });

  it("scopes an update to the actor's space and translates a unique violation", async () => {
    const database = fakeDatabase((call) => {
      if (call.text.startsWith("update")) {
        const conflict = new Error("duplicate key value violates unique constraint");
        Object.assign(conflict, { code: "23505" });
        throw conflict;
      }

      return [section];
    });
    const repositories = createRepositories(owner, database);

    await expect(repositories.sections.update("section-1", { name: "Work" })).rejects.toMatchObject(
      { _tag: "NameConflictError", message: 'a bot section named "Work" already exists' },
    );

    expect(database.calls[0]?.text).toContain("where id = $2 and space_id = $3 and user_id = $4");
  });

  it("throws not-found when an update or delete matches no row in the space", async () => {
    const repositories = createRepositories(owner, fakeDatabase());

    await expect(repositories.sections.update("section-1", { name: "Work" })).rejects.toMatchObject(
      { resource: "bot section", id: "section-1" },
    );
    await expect(repositories.sections.delete("section-1")).rejects.toMatchObject({
      resource: "bot section",
      id: "section-1",
    });
  });
});

describe("system scope", () => {
  it("offers a job reads and no writes", () => {
    const repositories = createRepositories(worker, fakeDatabase());

    expect(repositories.actor).toBe(worker);
    expect("create" in repositories.bots).toBe(false);
    expect("update" in repositories.bots).toBe(false);
    expect("archive" in repositories.bots).toBe(false);
    expect("restore" in repositories.bots).toBe(false);
    expect("delete" in repositories.bots).toBe(false);
    expect("setAvatar" in repositories.bots).toBe(false);
    expect("sections" in repositories).toBe(false);
    expect("createForBot" in repositories.threads).toBe(false);
    expect(rejectedSystemWrites(repositories)).toHaveLength(7);
  });

  it("scopes a job's reads to the job's space", async () => {
    const database = fakeDatabase();
    const repositories = createRepositories(worker, database);

    await repositories.runs.findById("run-1").catch(() => undefined);

    expect(database.calls[0]?.values).toEqual(["run-1", "space-1"]);
  });
});

describe("construction", () => {
  it("requires an actor, never a database or a tenant id", () => {
    const database = fakeDatabase();

    expect(rejectedConstruction(database)).toHaveLength(2);
    expect(() => createRepositories(owner, database)).not.toThrow();
  });
});
