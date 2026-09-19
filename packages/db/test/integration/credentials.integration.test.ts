import { randomUUID } from "node:crypto";
import { CredentialStoreError } from "@porkbot/effect";
import type { Credentials } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createCredentialKeyring, credentialEnvelopeKeyId } from "../../src/credential-cipher.ts";
import { createEncryptedCredentialStore } from "../../src/encrypted-credential-store.ts";
import { createRepositories } from "../../src/repositories.ts";

/**
 * Encrypted credentials proven where the binding lives: in Postgres.
 *
 * The unit suite proves the statements' shape over a fake client; this suite
 * answers what only a server can. A stored value round-trips, the row holds
 * ciphertext the value does not appear in, an envelope moved to another row
 * fails authentication, a second key decrypts the first key's rows while new
 * writes use it, a rotation rewrites only the stale rows (and only the actor's
 * space), and a keyring that holds neither key raises rather than returning
 * anything. Deleting the space cascades its ciphertext away.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;

let spaceA: string;
let spaceB: string;
let aliceId: string;
let bobId: string;

const value = "sk-live-0123456789abcdef";

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
  suite = await createSuiteDatabase({ suite: "db_encrypted_credentials" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  spaceA = await insertSpace("Credentials A");
  spaceB = await insertSpace("Credentials B");
  aliceId = await insertUser("Alice");
  bobId = await insertUser("Bob");
  await insertMembership(spaceA, aliceId, "owner");
  await insertMembership(spaceA, bobId, "member");
  await insertMembership(spaceB, bobId, "owner");
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

function storeFor(spaceId: string, keys?: ReturnType<typeof ring>): Credentials {
  return createEncryptedCredentialStore(operator(spaceId, aliceId), db(), keys);
}

function envelopeOf(spaceId: string, name: string): Promise<string> {
  return db()
    .query<{ readonly envelope: string }>(
      "select envelope from encrypted_credential where space_id = $1 and name = $2",
      [spaceId, name],
    )
    .then(({ rows }) => {
      const envelope = rows[0]?.envelope;

      if (envelope === undefined) {
        throw new Error(`expected a row for ${name}`);
      }

      return envelope;
    });
}

describe("the encrypted credential row", () => {
  it("stores ciphertext, resolves the value and lists only a mask", async () => {
    const store = storeFor(spaceA, ring("k1", [["k1", 1]]));

    await store.store("model-key", value);

    const envelope = await envelopeOf(spaceA, "model-key");

    expect(envelope.startsWith("v1:k1:")).toBe(true);
    expect(envelope).not.toContain(value);

    await expect(store.resolve("model-key")).resolves.toBe(value);

    const summaries = await store.list();

    expect(summaries.map(({ name }) => name)).toContain("model-key");
    expect(JSON.stringify(summaries)).not.toContain(value);
    expect(summaries.find(({ name }) => name === "model-key")?.maskedValue).toBe(
      `••••${value.slice(-4)}`,
    );
  });

  it("revokes a name for the next resolve and leaves another space's row alone", async () => {
    const keys = ring("k1", [["k1", 1]]);
    const storeA = storeFor(spaceA, keys);
    const storeB = storeFor(spaceB, keys);

    await storeA.store("revoked-key", value);
    await storeB.store("revoked-key", "sk-other-0123456789abcdef");

    await expect(storeA.resolve("revoked-key")).resolves.toBe(value);

    await storeA.remove("revoked-key");

    // The next resolve reads the table and the row is gone: the revoke is
    // immediate, and the same name in another space is not addressed at all.
    await expect(storeA.resolve("revoked-key")).resolves.toBeUndefined();
    await expect(storeB.resolve("revoked-key")).resolves.toBe("sk-other-0123456789abcdef");

    // Revoking a name no row holds is the same success, so a retry is safe.
    await expect(storeA.remove("revoked-key")).resolves.toBeUndefined();
  });

  it("fails authentication when the envelope is moved to another row", async () => {
    const store = storeFor(spaceA, ring("k1", [["k1", 1]]));

    await store.store("alpha", value);
    await store.store("beta", "sk-live-fedcba9876543210");

    // The move a database restore, a copy-paste or a crafted update could make:
    // beta's row now holds alpha's ciphertext.
    await db().query(
      "update encrypted_credential set envelope = $1 where space_id = $2 and name = $3",
      [await envelopeOf(spaceA, "alpha"), spaceA, "beta"],
    );

    const error = await store.resolve("beta").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).reason).toBe("corrupt");
    expect((error as Error).message).not.toContain(value);
  });

  it("fails authentication when the envelope is copied into another space", async () => {
    const store = storeFor(spaceA, ring("k1", [["k1", 1]]));

    await store.store("cross-space", value);

    const envelope = await envelopeOf(spaceA, "cross-space");

    await db().query(
      "insert into encrypted_credential (space_id, name, envelope) values ($1, $2, $3)",
      [spaceB, "cross-space", envelope],
    );

    const otherSpace = createEncryptedCredentialStore(
      operator(spaceB, bobId),
      db(),
      ring("k1", [["k1", 1]]),
    );

    await expect(otherSpace.resolve("cross-space")).rejects.toBeInstanceOf(CredentialStoreError);
  });

  it("scopes resolve and list to the actor's space", async () => {
    await db().query("delete from encrypted_credential where space_id = any($1::uuid[])", [
      [spaceA, spaceB],
    ]);

    await storeFor(spaceA, ring("k1", [["k1", 1]])).store("only-in-a", value);

    const spaceBStore = createEncryptedCredentialStore(
      operator(spaceB, bobId),
      db(),
      ring("k1", [["k1", 1]]),
    );

    await expect(spaceBStore.resolve("only-in-a")).resolves.toBeUndefined();
    await expect(spaceBStore.list()).resolves.toEqual([]);
  });
});

describe("key rotation", () => {
  it("decrypts old rows with the second key and rewrites them under it", async () => {
    const before = ring("k1", [["k1", 1]]);
    const after = ring("k2", [
      ["k1", 1],
      ["k2", 2],
    ]);
    const stale = createEncryptedCredentialStore(operator(spaceA, aliceId), db(), before);

    await stale.store("rotating", value);

    const rotating = createEncryptedCredentialStore(operator(spaceA, aliceId), db(), after);

    // The second key is introduced before any rewrite, so the old rows still
    // decrypt while the deployment serves.
    await expect(rotating.resolve("rotating")).resolves.toBe(value);

    await rotating.store("new-write", value);
    expect(credentialEnvelopeKeyId(await envelopeOf(spaceA, "new-write"))).toBe("k2");

    const rotation = await rotating.rotate();
    const repositories = createRepositories(operator(spaceA, aliceId), db(), {
      credentialKeys: after,
    });
    const rotationThroughRepositories = await repositories.credentials.rotate();

    expect(rotation.reencrypted).toBeGreaterThanOrEqual(1);
    expect(rotation.activeKeyId).toBe("k2");
    expect(rotationThroughRepositories.reencrypted).toBe(0);
    expect(credentialEnvelopeKeyId(await envelopeOf(spaceA, "rotating"))).toBe("k2");

    // The old key can now leave the deployment: every row decrypts under k2.
    const nextDeployment = createEncryptedCredentialStore(
      operator(spaceA, aliceId),
      db(),
      ring("k2", [["k2", 2]]),
    );

    await expect(nextDeployment.resolve("rotating")).resolves.toBe(value);
  });

  it("re-encrypts only the actor's space", async () => {
    const keys = ring("k2", [
      ["k1", 1],
      ["k2", 2],
    ]);
    const stale = ring("k1", [["k1", 1]]);

    await db().query("delete from encrypted_credential where space_id = any($1::uuid[])", [
      [spaceA, spaceB],
    ]);
    await createEncryptedCredentialStore(operator(spaceA, aliceId), db(), stale).store(
      "space-a-row",
      value,
    );
    await createEncryptedCredentialStore(operator(spaceB, bobId), db(), stale).store(
      "space-b-row",
      value,
    );

    await createEncryptedCredentialStore(operator(spaceA, aliceId), db(), keys).rotate();

    expect(credentialEnvelopeKeyId(await envelopeOf(spaceA, "space-a-row"))).toBe("k2");
    expect(credentialEnvelopeKeyId(await envelopeOf(spaceB, "space-b-row"))).toBe("k1");
  });

  it("raises unknown_key when neither the active nor the row's key is held", async () => {
    await db().query("delete from encrypted_credential where space_id = $1", [spaceA]);
    await createEncryptedCredentialStore(
      operator(spaceA, aliceId),
      db(),
      ring("k1", [["k1", 1]]),
    ).store("orphan", value);

    const withoutK1 = createEncryptedCredentialStore(
      operator(spaceA, aliceId),
      db(),
      ring("k2", [["k2", 2]]),
    );
    const error = await withoutK1.resolve("orphan").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).reason).toBe("unknown_key");
    expect((error as Error).message).not.toContain(value);
  });
});

describe("the job's half and the space cascade", () => {
  it("resolves one name through the job's space and cannot enumerate", async () => {
    await db().query("delete from encrypted_credential where space_id = $1", [spaceA]);
    await createEncryptedCredentialStore(
      operator(spaceA, aliceId),
      db(),
      ring("k1", [["k1", 1]]),
    ).store("job-key", value);

    const job = createEncryptedCredentialStore(systemActor(spaceA), db(), ring("k1", [["k1", 1]]));

    await expect(job.resolve("job-key")).resolves.toBe(value);
    expect("list" in job).toBe(false);
  });

  it("removes every ciphertext with its space", async () => {
    const temporary = await insertSpace("Credentials cascade");
    await insertMembership(temporary, aliceId, "owner");
    await createEncryptedCredentialStore(
      operator(temporary, aliceId),
      db(),
      ring("k1", [["k1", 1]]),
    ).store("doomed", value);

    await db().query("delete from space where id = $1", [temporary]);

    const { rows } = await db().query<{ readonly count: number }>(
      "select count(*)::int as count from encrypted_credential where space_id = $1",
      [temporary],
    );

    expect(rows[0]?.count).toBe(0);
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
