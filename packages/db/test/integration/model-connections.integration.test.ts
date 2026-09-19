import { randomUUID } from "node:crypto";
import { NameConflictError, NotFoundError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";
import type { ModelConnectionRecord, UserRepositories } from "../../src/repositories.ts";

/**
 * Model connections and per-bot model selection proven where the rules live:
 * in Postgres.
 *
 * The unit suite proves the statements' shape over a fake client; this suite
 * answers what only a server can. A connection round-trips and its label is
 * unique per space; every scoped read and write refuses another space; the
 * partial unique index admits one default per space and the swap leaves
 * exactly one; `resolveForBot` applies the bot's own connection and model
 * before the space default; an unset model on both sides resolves to nothing
 * rather than an empty id; and deleting a connection nulls the bots that
 * selected it, so they fall back to the default instead of dangling.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let spaceA: string;
let spaceB: string;
let spaceC: string;
let aliceId: string;
let bobId: string;

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_model_connections" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  spaceA = await insertSpace("Model connections A");
  spaceB = await insertSpace("Model connections B");
  spaceC = await insertSpace("Model connections C");
  aliceId = await insertUser("Alice");
  bobId = await insertUser("Bob");
  await insertMembership(spaceA, aliceId, "owner");
  await insertMembership(spaceB, bobId, "owner");
  await insertMembership(spaceC, aliceId, "owner");
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

function operator(spaceId: string, userId: string): UserActor {
  return { kind: "user", spaceId, userId, role: "owner" };
}

function systemActor(spaceId: string): SystemActor {
  return { kind: "system", spaceId, jobId: `job-${randomUUID()}` };
}

function repositories(spaceId: string, userId: string): UserRepositories {
  return createRepositories(operator(spaceId, userId), db());
}

async function createConnection(
  spaceId: string,
  label: string,
  overrides: Partial<{ baseUrl: string; credentialName: string; defaultModel: string | null }> = {},
): Promise<ModelConnectionRecord> {
  return repositories(spaceId, aliceId).modelConnections.create({
    label,
    baseUrl: overrides.baseUrl ?? "https://model.example.invalid/v1",
    credentialName: overrides.credentialName ?? "model-key",
    defaultModel: overrides.defaultModel === undefined ? "fixture-model" : overrides.defaultModel,
  });
}

async function createBot(
  spaceId: string,
  overrides: Partial<{ modelConnectionId: string | null; model: string | null }> = {},
): Promise<string> {
  const bot = await repositories(spaceId, aliceId).bots.create({
    name: "Model host",
    color: "#4f46e5",
    spawnKey: randomUUID(),
    modelConnectionId: overrides.modelConnectionId ?? null,
    model: overrides.model ?? null,
  });

  return bot.id;
}

describe("the model connection row", () => {
  it("round-trips, updates and removes through the actor's scope", async () => {
    const store = repositories(spaceA, aliceId).modelConnections;
    const created = await createConnection(spaceA, `Local ${randomUUID()}`);

    await expect(store.findById(created.id)).resolves.toMatchObject({
      label: created.label,
      defaultModel: "fixture-model",
      isDefault: false,
    });

    const updated = await store.update(created.id, {
      label: `${created.label} edited`,
      defaultModel: null,
    });
    expect(updated).toMatchObject({ label: `${created.label} edited`, defaultModel: null });

    const removed = await store.delete(created.id);
    expect(removed.id).toBe(created.id);
    await expect(store.findById(created.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a label already used in the space", async () => {
    const label = `Duplicate ${randomUUID()}`;
    await createConnection(spaceA, label);

    await expect(createConnection(spaceA, label)).rejects.toBeInstanceOf(NameConflictError);
  });

  it("keeps exactly one default across the swap", async () => {
    const store = repositories(spaceA, aliceId).modelConnections;
    const first = await createConnection(spaceA, `First ${randomUUID()}`);
    const second = await createConnection(spaceA, `Second ${randomUUID()}`);

    await store.setDefault(second.id);
    await store.setDefault(first.id);
    await store.setDefault(second.id);

    const listed = await store.list();
    const defaults = listed.filter((record) => record.isDefault);

    expect(defaults.map((record) => record.id)).toEqual([second.id]);
    expect(defaults).toHaveLength(1);
  });

  it("refuses another space's connection on every scoped seam", async () => {
    const created = await createConnection(spaceA, `Private ${randomUUID()}`);
    const foreign = repositories(spaceB, bobId).modelConnections;

    await expect(foreign.findById(created.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(foreign.update(created.id, { label: "stolen" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(foreign.setDefault(created.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(foreign.delete(created.id)).rejects.toBeInstanceOf(NotFoundError);

    const { rows } = await db().query<{ readonly label: string }>(
      "select label from model_connection where id = $1",
      [created.id],
    );
    expect(rows[0]?.label).toBe(created.label);
  });

  it("refuses a bot write that names another space's connection", async () => {
    const foreignConnection = await createConnection(spaceB, `Foreign ${randomUUID()}`);
    const botId = await createBot(spaceA);

    await expect(
      repositories(spaceA, aliceId).bots.update(botId, {
        modelConnectionId: foreignConnection.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const { rows } = await db().query<{ readonly modelConnectionId: string | null }>(
      'select model_connection_id as "modelConnectionId" from bot where id = $1',
      [botId],
    );
    expect(rows[0]?.modelConnectionId).toBeNull();
  });
});

describe("the model selection a bot resolves", () => {
  it("falls back to the space default connection and its default model", async () => {
    const store = repositories(spaceA, aliceId).modelConnections;
    const connection = await createConnection(spaceA, `Default ${randomUUID()}`);
    await store.setDefault(connection.id);
    const botId = await createBot(spaceA);

    await expect(
      repositories(spaceA, aliceId).modelConnections.findById(connection.id),
    ).resolves.toMatchObject({ isDefault: true });
    await expect(
      createRepositories(systemActor(spaceA), db()).modelConnections.resolveForBot(botId),
    ).resolves.toEqual({
      connectionId: connection.id,
      baseUrl: connection.baseUrl,
      credentialName: connection.credentialName,
      model: "fixture-model",
    });
  });

  it("prefers the bot's own model over the connection default", async () => {
    const connection = await createConnection(spaceA, `Override ${randomUUID()}`);
    await repositories(spaceA, aliceId).modelConnections.setDefault(connection.id);
    const botId = await createBot(spaceA, { model: "bot-model" });

    await expect(
      createRepositories(systemActor(spaceA), db()).modelConnections.resolveForBot(botId),
    ).resolves.toMatchObject({ connectionId: connection.id, model: "bot-model" });
  });

  it("prefers the bot's own connection without disturbing the space default", async () => {
    const store = repositories(spaceA, aliceId).modelConnections;
    const spaceDefault = await createConnection(spaceA, `Space ${randomUUID()}`);
    const botChoice = await createConnection(spaceA, `Bot ${randomUUID()}`, {
      baseUrl: "https://bot.example.invalid/v1",
    });
    await store.setDefault(spaceDefault.id);
    const botId = await createBot(spaceA, { modelConnectionId: botChoice.id, model: "bot-model" });

    await expect(
      createRepositories(systemActor(spaceA), db()).modelConnections.resolveForBot(botId),
    ).resolves.toMatchObject({
      connectionId: botChoice.id,
      baseUrl: "https://bot.example.invalid/v1",
      model: "bot-model",
    });
    await expect(store.findById(spaceDefault.id)).resolves.toMatchObject({ isDefault: true });
  });

  it("answers nothing when no connection or no model is selected", async () => {
    // A model id with no connection anywhere resolves to nothing: the space
    // with no default is `spaceC`, and the default connection in `spaceA`
    // carries no model of its own.
    const modelOnly = await createBot(spaceC, { model: "bot-model" });
    const connection = await createConnection(spaceA, `No model ${randomUUID()}`, {
      defaultModel: null,
    });
    await repositories(spaceA, aliceId).modelConnections.setDefault(connection.id);
    const botWithoutModel = await createBot(spaceA);

    const withoutDefault = createRepositories(systemActor(spaceC), db()).modelConnections;
    const withoutModel = createRepositories(systemActor(spaceA), db()).modelConnections;
    await expect(withoutDefault.resolveForBot(modelOnly)).resolves.toBeUndefined();
    await expect(withoutModel.resolveForBot(botWithoutModel)).resolves.toBeUndefined();
  });

  it("nulls a deleted connection on its bots and falls back to the default", async () => {
    const store = repositories(spaceA, aliceId).modelConnections;
    const fallback = await createConnection(spaceA, `Fallback ${randomUUID()}`);
    const selected = await createConnection(spaceA, `Selected ${randomUUID()}`);
    await store.setDefault(fallback.id);
    const botId = await createBot(spaceA, { modelConnectionId: selected.id });
    await store.delete(selected.id);

    const { rows } = await db().query<{ readonly modelConnectionId: string | null }>(
      'select model_connection_id as "modelConnectionId" from bot where id = $1',
      [botId],
    );
    expect(rows[0]?.modelConnectionId).toBeNull();

    await expect(
      createRepositories(systemActor(spaceA), db()).modelConnections.resolveForBot(botId),
    ).resolves.toMatchObject({ connectionId: fallback.id, model: "fixture-model" });
  });

  it("refuses another space's bot without leaking whether it exists", async () => {
    const botId = await createBot(spaceA);

    await expect(
      createRepositories(systemActor(spaceB), db()).modelConnections.resolveForBot(botId),
    ).resolves.toBeUndefined();
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
