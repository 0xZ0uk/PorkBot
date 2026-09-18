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

/** The same proof for a system actor: this slice gives a job reads, no writes. */
function rejectedSystemWrites(repositories: SystemRepositories): readonly (() => unknown)[] {
  return [
    // @ts-expect-error -- a job has no user to attribute a bot to.
    () => repositories.bots.create({ name: "Ada", color: "#000000", spawnKey: "spawn-1" }),
    // @ts-expect-error -- a job cannot update a user-owned bot in this slice.
    () => repositories.bots.update("bot-1", { name: "Grace" }),
    // @ts-expect-error -- a job cannot create a thread; it has no user of record.
    () => repositories.threads.createForBot("bot-1"),
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

    expect(database.calls).toHaveLength(6);

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
      "spawn-1",
    ]);
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

  it("treats an empty insert result as a fault, not a missing row", async () => {
    const repositories = createRepositories(owner, fakeDatabase());

    await expect(
      repositories.bots.create({ name: "Ada", color: "#000000", spawnKey: "spawn-1" }),
    ).rejects.toThrow("the database returned no row for an insert");
  });
});

describe("system scope", () => {
  it("offers a job reads and no writes", () => {
    const repositories = createRepositories(worker, fakeDatabase());

    expect(repositories.actor).toBe(worker);
    expect("create" in repositories.bots).toBe(false);
    expect("update" in repositories.bots).toBe(false);
    expect("createForBot" in repositories.threads).toBe(false);
    expect(rejectedSystemWrites(repositories)).toHaveLength(3);
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
