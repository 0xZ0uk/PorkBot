import { randomUUID } from "node:crypto";
import { BotSecretDestinationError, CredentialStoreError, NotFoundError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createBotSecretStore } from "../../src/bot-secret-store.ts";
import { createCredentialKeyring, credentialEnvelopeKeyId } from "../../src/credential-cipher.ts";
import { createEncryptedCredentialStore } from "../../src/encrypted-credential-store.ts";

/**
 * Bot secrets proven where the binding lives: in Postgres (slice 9.6).
 *
 * The unit suite proves the statements' shape over a fake client; this suite
 * answers what only a server can. A value round-trips through the run's
 * resolver, the row holds ciphertext the value does not appear in, a
 * destination is refused beside a stored value, a forget clears the value and
 * keeps the row's audit line, an envelope moved between bots (or into the
 * space's credentials) fails authentication, a second key decrypts the first
 * key's rows while new writes use it, a foreign bot is the shared not-found
 * before a row is read, and deleting a bot cascades its secrets away.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let spaceA: string;
let spaceB: string;
let aliceId: string;
let bobId: string;
let botA: string;
let botB: string;

const value = "sk-live-0123456789abcdef";
const name = "example_api";
const origin = "https://api.example.test";
const destination = { name, origin, auth: { type: "bearer" as const } };

const ring = (activeKeyId: string, entries: readonly (readonly [string, number])[]) =>
  createCredentialKeyring({
    activeKeyId,
    keys: entries.map(([id, fill]) => ({ id, key: Buffer.alloc(32, fill).toString("base64") })),
  });

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_bot_secrets" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  spaceA = await insertSpace("Bot secrets A");
  spaceB = await insertSpace("Bot secrets B");
  aliceId = await insertUser("Alice");
  bobId = await insertUser("Bob");
  await insertMembership(spaceA, aliceId, "owner");
  await insertMembership(spaceB, bobId, "owner");
  botA = await insertBot(spaceA, aliceId, "Secrets A");
  botB = await insertBot(spaceA, aliceId, "Secrets B");
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

function operatorStore(spaceId: string, keys?: ReturnType<typeof ring>) {
  return createBotSecretStore(operator(spaceId, aliceId), db(), keys);
}

function runStore(spaceId: string, keys?: ReturnType<typeof ring>) {
  return createBotSecretStore(systemActor(spaceId), db(), keys);
}

function envelopeOf(botId: string, secretName: string): Promise<string | null> {
  return db()
    .query<{ readonly envelope: string | null }>(
      "select envelope from bot_secret where bot_id = $1 and name = $2",
      [botId, secretName],
    )
    .then(({ rows }) => rows[0]?.envelope ?? null);
}

describe("the stored bot secret row", () => {
  it("stores ciphertext, resolves through the run's half and lists metadata only", async () => {
    const store = operatorStore(spaceA, ring("k1", [["k1", 1]]));

    await store.put(botA, destination, value);

    const envelope = await envelopeOf(botA, name);

    expect(envelope?.startsWith("v1:k1:")).toBe(true);
    expect(envelope).not.toContain(value);

    const run = runStore(spaceA, ring("k1", [["k1", 1]]));

    await expect(run.resolve(botA, name)).resolves.toEqual({
      destination,
      value,
    });

    const summaries = await store.list(botA);

    expect(summaries).toMatchObject([{ name, status: "stored", origin }]);
    expect(JSON.stringify(summaries)).not.toContain(value);
    // The list needs no keyring: nothing on it derives from the value.
    await expect(
      createBotSecretStore(operator(spaceA, aliceId), db(), undefined).list(botA),
    ).resolves.toMatchObject([{ name, status: "stored" }]);
  });

  it("forgets immediately and keeps the row's audit line", async () => {
    const keys = ring("k1", [["k1", 1]]);
    const store = operatorStore(spaceA, keys);

    await store.put(botB, { ...destination, name: "forgotten_api" }, value);
    await expect(store.forget(botB, "forgotten_api")).resolves.toEqual({ removed: true });

    // The value is gone before the call returns, and the run's resolver
    // answers nothing from the next call on.
    await expect(envelopeOf(botB, "forgotten_api")).resolves.toBeNull();
    await expect(runStore(spaceA, keys).resolve(botB, "forgotten_api")).resolves.toBeUndefined();
    await expect(store.list(botB)).resolves.toMatchObject([
      { name: "forgotten_api", status: "forgotten" },
    ]);

    // A second forget removed nothing, which is the honest retry answer.
    await expect(store.forget(botB, "forgotten_api")).resolves.toEqual({ removed: false });
  });

  it("refuses a new destination beside a stored value and allows one after a forget", async () => {
    const store = operatorStore(spaceA, ring("k1", [["k1", 1]]));
    const other = { ...destination, name: "movable_api" };

    await store.put(botA, other, value);

    const error = await store
      .put(botA, { ...other, origin: "https://collect.example.invalid" }, value)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BotSecretDestinationError);
    expect((error as Error).message).not.toContain(value);
    await expect(envelopeOf(botA, "movable_api")).resolves.not.toBeNull();

    // A forgotten row holds no value, so the operator may point the name at a
    // new destination and store a fresh value.
    await store.forget(botA, "movable_api");
    await expect(
      store.put(botA, { ...other, origin: "https://other.example.test" }, value),
    ).resolves.toMatchObject({ origin: "https://other.example.test", status: "stored" });
  });

  it("fails authentication when the envelope is moved to another bot", async () => {
    const keys = ring("k1", [["k1", 1]]);
    const store = operatorStore(spaceA, keys);

    await store.put(botA, { ...destination, name: "alpha" }, value);
    await store.put(botA, { ...destination, name: "beta" }, "sk-live-fedcba9876543210");

    await db().query("update bot_secret set envelope = $1 where bot_id = $2 and name = $3", [
      await envelopeOf(botA, "alpha"),
      botA,
      "beta",
    ]);

    const error = await runStore(spaceA, keys)
      .resolve(botA, "beta")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).reason).toBe("corrupt");
    expect((error as Error).message).not.toContain(value);
  });

  it("fails authentication when a bot secret's envelope moves into the space credentials", async () => {
    const keys = ring("k1", [["k1", 1]]);

    await operatorStore(spaceA, keys).put(botA, { ...destination, name: "leaked" }, value);

    const envelope = await envelopeOf(botA, "leaked");

    await db().query(
      "insert into encrypted_credential (space_id, name, envelope) values ($1, $2, $3)",
      [spaceA, "leaked", envelope],
    );

    await expect(
      createEncryptedCredentialStore(operator(spaceA, aliceId), db(), keys).resolve("leaked"),
    ).rejects.toBeInstanceOf(CredentialStoreError);
  });

  it("refuses a foreign bot before reading or writing any row", async () => {
    const keys = ring("k1", [["k1", 1]]);
    const foreign = operatorStore(spaceB, keys);

    for (const call of [
      () => foreign.list(botA),
      () => foreign.find(botA, name),
      () => foreign.put(botA, destination, value),
      () => foreign.forget(botA, name),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundError);
    }

    await expect(runStore(spaceB, keys).resolve(botA, name)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("key rotation", () => {
  it("decrypts old rows with the second key and rewrites the actor's space under it", async () => {
    await db().query("delete from bot_secret where space_id = any($1::uuid[])", [[spaceA, spaceB]]);

    const before = ring("k1", [["k1", 1]]);
    const after = ring("k2", [
      ["k1", 1],
      ["k2", 2],
    ]);
    const botInB = await insertBot(spaceB, bobId, "Secrets B");

    await operatorStore(spaceA, before).put(botA, { ...destination, name: "rotating" }, value);
    await createBotSecretStore(operator(spaceB, bobId), db(), before).put(
      botInB,
      { ...destination, name: "other_space" },
      value,
    );

    // The second key is introduced before any rewrite, so the old rows still
    // decrypt while the deployment serves.
    await expect(runStore(spaceA, after).resolve(botA, "rotating")).resolves.toMatchObject({
      value,
    });

    const rotation = await operatorStore(spaceA, after).rotate();

    expect(rotation).toEqual({ activeKeyId: "k2", reencrypted: 1, total: 1 });
    expect(credentialEnvelopeKeyId((await envelopeOf(botA, "rotating")) ?? "")).toBe("k2");
    expect(credentialEnvelopeKeyId((await envelopeOf(botInB, "other_space")) ?? "")).toBe("k1");

    // The old key can now leave the deployment: every row decrypts under k2.
    await expect(
      runStore(spaceA, ring("k2", [["k2", 2]])).resolve(botA, "rotating"),
    ).resolves.toMatchObject({ value });
  });
});

describe("the bot cascade", () => {
  it("removes a bot's secrets with the bot", async () => {
    const temporary = await insertBot(spaceA, aliceId, "Doomed");

    await operatorStore(spaceA, ring("k1", [["k1", 1]])).put(temporary, destination, value);

    await db().query("delete from bot where id = $1", [temporary]);

    const { rows } = await db().query<{ readonly count: number }>(
      "select count(*)::int as count from bot_secret where bot_id = $1",
      [temporary],
    );

    expect(rows[0]?.count).toBe(0);
  });
});

async function insertSpace(spaceName: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into space (name) values ($1) returning id",
    [spaceName],
  );

  return requiredId(rows[0], "a space");
}

async function insertUser(userName: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id',
    [userName, `${randomUUID()}@example.test`],
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

async function insertBot(spaceId: string, userId: string, botName: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into bot (space_id, user_id, name, color, spawn_key) " +
      "values ($1, $2, $3, $4, $5) returning id",
    [spaceId, userId, botName, "#123456", randomUUID()],
  );

  return requiredId(rows[0], "a bot");
}

function requiredId(row: { id: string } | undefined, what: string): string {
  if (row === undefined) {
    throw new Error(`expected ${what} to insert and return its id`);
  }

  return row.id;
}
