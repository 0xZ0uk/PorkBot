import { BotSecretDestinationError, CredentialStoreError, NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import { createBotSecretStore } from "./bot-secret-store.ts";
import {
  createCredentialKeyring,
  decryptCredentialValue,
  encryptCredentialValue,
} from "./credential-cipher.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The bot-secret store without a server: a recording fake stands in for the pg
 * client, so these tests prove the module's own contract — the value is
 * encrypted before it reaches the database, the ciphertext is bound to the
 * bot, a destination beside a stored value is refused, a foreign bot is the
 * shared not-found before any row is touched, and a rotation re-encrypts only
 * the rows the active key has not already written.
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

const operator: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const worker: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };

const botId = "bot-1";
const name = "example_api";
const origin = "https://api.example.test";
const secret = "sk-live-0123456789abcdef";
const destination = { name, origin, auth: { type: "bearer" as const } };

const keyring = (activeKeyId: string, entries: readonly (readonly [string, number])[]) =>
  createCredentialKeyring({
    activeKeyId,
    keys: entries.map(([id, fill]) => ({ id, key: Buffer.alloc(32, fill).toString("base64") })),
  });

const keys = keyring("k2", [
  ["k1", 1],
  ["k2", 2],
]);

const isBotCheck = (text: string): boolean => text.startsWith("select id from bot where");
const isList = (text: string): boolean =>
  text.startsWith("select id, name, origin, auth, envelope") && text.includes("order by name asc");
const isFind = (text: string): boolean =>
  text.startsWith("select id, name, origin, auth, envelope") && !text.includes("order by");
const isResolve = (text: string): boolean =>
  text.startsWith("select origin, auth, envelope from bot_secret");
const isUpsert = (text: string): boolean => text.startsWith("insert into bot_secret");
const isForget = (text: string): boolean =>
  text.startsWith("update bot_secret set envelope = null");
const isRotateSelect = (text: string): boolean =>
  text.startsWith("select id, bot_id as") && text.includes("envelope is not null");
const isRotateUpdate = (text: string): boolean =>
  text.startsWith("update bot_secret set envelope = $1");

const botRow = (): readonly unknown[] => [{ id: botId }];

function envelopeFor(
  value: string,
  ring = keys,
  binding: { spaceId: string; botId?: string | undefined; name: string } = {
    spaceId: "space-1",
    botId,
    name,
  },
): string {
  return encryptCredentialValue(ring, binding, value);
}

const secretRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "row-1",
  name,
  origin,
  auth: { type: "bearer" },
  envelope: envelopeFor(secret),
  forgottenAt: null,
  createdAt: new Date("2026-09-19T10:00:00.000Z"),
  updatedAt: new Date("2026-09-19T10:00:00.000Z"),
  ...overrides,
});

describe("a locked store", () => {
  it("refuses the value-bearing calls before touching the database", async () => {
    const database = fakeDatabase();
    const store = createBotSecretStore(operator, database);

    for (const call of [
      () => createBotSecretStore(worker, database).resolve(botId, name),
      () => store.put(botId, destination, secret),
      () => store.rotate(),
    ]) {
      const error = await call().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(CredentialStoreError);
      expect((error as CredentialStoreError).reason).toBe("locked");
    }

    expect(database.calls).toEqual([]);
  });

  it("still lists, finds and forgets so an operator can clean up", async () => {
    const database = fakeDatabase((call) => {
      if (isBotCheck(call.text)) return botRow();
      if (isList(call.text)) return [secretRow()];
      if (isForget(call.text)) return [{ id: "row-1" }];
      return [];
    });
    const store = createBotSecretStore(operator, database, undefined);

    await expect(store.list(botId)).resolves.toHaveLength(1);
    await expect(store.forget(botId, name)).resolves.toEqual({ removed: true });
  });
});

describe("the operator's half", () => {
  it("stores the value encrypted and reports a status, never the value", async () => {
    const database = fakeDatabase((call) => {
      if (isBotCheck(call.text)) return botRow();
      if (isResolve(call.text)) return [];
      if (isUpsert(call.text)) return [secretRow()];
      return [];
    });
    const store = createBotSecretStore(operator, database, keys);
    const summary = await store.put(botId, destination, secret);
    const upsert = database.calls.find(({ text }) => isUpsert(text));

    expect(upsert?.values.slice(0, 5)).toEqual([
      "space-1",
      botId,
      name,
      origin,
      JSON.stringify({ type: "bearer" }),
    ]);
    expect(upsert?.values).not.toContain(secret);
    expect(summary.status).toBe("stored");
    expect(JSON.stringify(summary)).not.toContain(secret);

    const envelope = String(upsert?.values[5]);

    expect(decryptCredentialValue(keys, { spaceId: "space-1", botId, name }, envelope)).toBe(
      secret,
    );
  });

  it("refuses a new destination beside a stored value", async () => {
    const database = fakeDatabase((call) => {
      if (isBotCheck(call.text)) return botRow();
      if (isResolve(call.text)) {
        return [{ origin, auth: { type: "bearer" }, envelope: envelopeFor(secret, keys) }];
      }
      return [];
    });
    const store = createBotSecretStore(operator, database, keys);
    const error = await store
      .put(botId, { ...destination, origin: "https://collect.example.invalid" }, secret)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BotSecretDestinationError);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).not.toContain(secret);
    expect(database.calls.some(({ text }) => isUpsert(text))).toBe(false);
  });

  it("allows a new destination when the row holds no value", async () => {
    const database = fakeDatabase((call) => {
      if (isBotCheck(call.text)) return botRow();
      if (isResolve(call.text)) return [{ origin, auth: { type: "bearer" }, envelope: null }];
      if (isUpsert(call.text)) return [secretRow()];
      return [];
    });
    const store = createBotSecretStore(operator, database, keys);

    await expect(
      store.put(botId, { ...destination, origin: "https://other.example.test" }, secret),
    ).resolves.toMatchObject({ status: "stored" });
  });

  it("refuses a foreign bot before reading or writing any row", async () => {
    const database = fakeDatabase(() => []);
    const store = createBotSecretStore(operator, database, keys);

    for (const call of [
      () => store.list(botId),
      () => store.find(botId, name),
      () => store.put(botId, destination, secret),
      () => store.forget(botId, name),
    ]) {
      const error = await call().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(NotFoundError);
    }

    expect(database.calls.every(({ text }) => isBotCheck(text))).toBe(true);
  });

  it("lists a forgotten row by its status and finds it by name", async () => {
    const database = fakeDatabase((call) => {
      if (isBotCheck(call.text)) return botRow();
      if (isList(call.text)) return [secretRow({ envelope: null })];
      if (isFind(call.text)) {
        return call.values[2] === name ? [secretRow({ envelope: null })] : [];
      }
      return [];
    });
    const store = createBotSecretStore(operator, database, keys);

    await expect(store.list(botId)).resolves.toMatchObject([{ name, status: "forgotten", origin }]);
    await expect(store.find(botId, name)).resolves.toMatchObject({ name, status: "forgotten" });
    await expect(store.find(botId, "nobody")).resolves.toBeUndefined();

    // The list answered without a keyring: only the status derives from the row.
    const withoutKeys = createBotSecretStore(operator, database, undefined);
    await expect(withoutKeys.list(botId)).resolves.toMatchObject([{ name, status: "forgotten" }]);
  });

  it("answers a forget that removed no value honestly", async () => {
    const database = fakeDatabase((call) => {
      if (isBotCheck(call.text)) return botRow();
      if (isForget(call.text)) return [];
      return [];
    });
    const store = createBotSecretStore(operator, database, keys);

    await expect(store.forget(botId, name)).resolves.toEqual({ removed: false });
  });
});

describe("the job's half", () => {
  it("resolves the value for its own bot and distinguishes a forgotten row", async () => {
    const database = fakeDatabase((call) => {
      if (isBotCheck(call.text)) return botRow();
      if (isResolve(call.text)) {
        return call.values[2] === name
          ? [
              {
                origin,
                auth: { type: "basic", username: "api-user" },
                envelope: envelopeFor(secret),
              },
            ]
          : [{ origin, auth: { type: "bearer" }, envelope: null }];
      }
      return [];
    });
    const store = createBotSecretStore(worker, database, keys);

    await expect(store.resolve(botId, name)).resolves.toEqual({
      destination: { name, origin, auth: { type: "basic", username: "api-user" } },
      value: secret,
    });
    await expect(store.resolve(botId, "other_api")).resolves.toBeUndefined();
    expect("put" in store).toBe(false);
    expect("rotate" in store).toBe(false);
  });

  it("refuses to resolve another space's bot", async () => {
    const database = fakeDatabase(() => []);
    const store = createBotSecretStore(worker, database, keys);

    await expect(store.resolve(botId, name)).rejects.toBeInstanceOf(NotFoundError);
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.text).toContain("space_id = $1");
    expect(database.calls[0]?.values).toEqual(["space-1", botId]);
  });
});

describe("rotation", () => {
  it("re-encrypts only the stale rows and writes them under the active key", async () => {
    const stale = envelopeFor(secret, keyring("k1", [["k1", 1]]));
    const database = fakeDatabase((call) => {
      if (isRotateSelect(call.text)) {
        return [
          { id: "row-stale", botId, name, envelope: stale },
          { id: "row-active", botId, name: "other", envelope: envelopeFor(secret) },
        ];
      }
      return [];
    });
    const store = createBotSecretStore(operator, database, keys);
    const rotation = await store.rotate();
    const updates = database.calls.filter(({ text }) => isRotateUpdate(text));

    expect(rotation).toEqual({ activeKeyId: "k2", reencrypted: 1, total: 2 });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values[1]).toBe("row-stale");
    expect(updates[0]?.values[2]).toBe("space-1");

    const rewritten = String(updates[0]?.values[0]);

    expect(rewritten.startsWith("v1:k2:")).toBe(true);
    expect(decryptCredentialValue(keys, { spaceId: "space-1", botId, name }, rewritten)).toBe(
      secret,
    );
  });
});
