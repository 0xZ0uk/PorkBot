import { createRunEventRecorder, CredentialStoreError } from "@porkbot/effect";
import { createLogger, redactedPlaceholder } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import {
  createCredentialKeyring,
  decryptCredentialValue,
  encryptCredentialValue,
} from "./credential-cipher.ts";
import { createEncryptedCredentialStore } from "./encrypted-credential-store.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The encrypted credential store without a server: a recording fake stands in
 * for the pg client, so these tests prove the module's own contract — every
 * value is encrypted before it reaches the database, a list answers masks, a
 * record read through the wrong row fails authentication, and a rotation
 * re-encrypts only the rows the active key has not already written. Whether the
 * unique index really absorbs a concurrent second store is not provable here;
 * the integration suite runs the same calls against Postgres.
 *
 * The last describe is the secrecy acceptance criterion: the known key shape
 * never survives an error message or the event recorder that feeds the
 * timeline.
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

const secret = "sk-live-0123456789abcdef";
const masked = `••••${secret.slice(-4)}`;

const keyring = (activeKeyId: string, entries: readonly (readonly [string, number])[]) =>
  createCredentialKeyring({
    activeKeyId,
    keys: entries.map(([id, fill]) => ({ id, key: Buffer.alloc(32, fill).toString("base64") })),
  });

const keys = keyring("k2", [
  ["k1", 1],
  ["k2", 2],
]);

/** A row as the store's reads see it, encrypted for its own name. */
const row = (name: string, value = secret) => ({
  id: `row-${name}`,
  name,
  envelope: encryptCredentialValue(keys, { spaceId: "space-1", name }, value),
  createdAt: new Date("2026-09-18T10:00:00.000Z"),
  updatedAt: new Date("2026-09-18T10:00:00.000Z"),
});

const isSelect = (text: string): boolean =>
  text.startsWith("select id, name, envelope, created_at") && text.includes("order by name asc");
const isResolve = (text: string): boolean =>
  text.startsWith("select envelope from encrypted_credential");
const isUpsert = (text: string): boolean => text.startsWith("insert into encrypted_credential");
const isRotateUpdate = (text: string): boolean =>
  text.startsWith("update encrypted_credential set envelope");

describe("a locked store", () => {
  it("refuses every operation before touching the database", async () => {
    const database = fakeDatabase();
    const store = createEncryptedCredentialStore(operator, database);

    for (const call of [
      () => store.resolve("model-key"),
      () => store.list(),
      () => store.store("model-key", secret),
      () => store.rotate(),
    ]) {
      const error = await call().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(CredentialStoreError);
      expect((error as CredentialStoreError).reason).toBe("locked");
    }

    expect(database.calls).toEqual([]);
  });
});

describe("the operator's half", () => {
  it("answers a missing name with undefined and a stored one with its value", async () => {
    const database = fakeDatabase(({ values }) =>
      values[1] === "model-key" ? [{ envelope: row("model-key").envelope }] : [],
    );
    const store = createEncryptedCredentialStore(operator, database, keys);

    await expect(store.resolve("missing")).resolves.toBeUndefined();
    await expect(store.resolve("model-key")).resolves.toBe(secret);
    expect(database.calls[0]?.values).toEqual(["space-1", "missing"]);
    expect(database.calls[1]?.values).toEqual(["space-1", "model-key"]);
  });

  it("fails authentication when the row's envelope belongs to another name", async () => {
    const database = fakeDatabase(() => [{ envelope: row("alpha").envelope }]);
    const store = createEncryptedCredentialStore(operator, database, keys);
    const error = await store.resolve("beta").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).reason).toBe("corrupt");
    expect((error as Error).message).not.toContain(secret);
  });

  it("stores the value encrypted, never plaintext, and answers a mask", async () => {
    const database = fakeDatabase(({ values }) => [row(String(values[1]), String(values[2]))]);
    const store = createEncryptedCredentialStore(operator, database, keys);
    const summary = await store.store("model-key", secret);
    const upsert = database.calls.find(({ text }) => isUpsert(text));

    expect(upsert?.text).toContain("on conflict (space_id, name)");
    expect(upsert?.values[0]).toBe("space-1");
    expect(upsert?.values[1]).toBe("model-key");
    expect(upsert?.values).not.toContain(secret);
    expect(summary.maskedValue).toBe(masked);
    expect(JSON.stringify(summary)).not.toContain(secret);

    const envelope = String(upsert?.values[2]);

    expect(decryptCredentialValue(keys, { spaceId: "space-1", name: "model-key" }, envelope)).toBe(
      secret,
    );
  });

  it("refuses a blank value rather than storing a secret that authenticates as empty", async () => {
    const database = fakeDatabase();
    const store = createEncryptedCredentialStore(operator, database, keys);
    const error = await store.store("model-key", "   ").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(database.calls).toEqual([]);
  });

  it("lists only masked summaries, scoped to the actor's space", async () => {
    const database = fakeDatabase(({ text }) =>
      isSelect(text) ? [row("alpha"), row("beta")] : [],
    );
    const store = createEncryptedCredentialStore(operator, database, keys);
    const summaries = await store.list();
    const select = database.calls.find(({ text }) => isSelect(text));

    expect(summaries.map(({ name, maskedValue }) => ({ name, maskedValue }))).toEqual([
      { name: "alpha", maskedValue: masked },
      { name: "beta", maskedValue: masked },
    ]);
    expect(JSON.stringify(summaries)).not.toContain(secret);
    expect(select?.values).toEqual(["space-1"]);
  });

  it("removes one scoped row without needing the keyring", async () => {
    const database = fakeDatabase();
    const store = createEncryptedCredentialStore(operator, database, undefined);

    await store.remove("model-key");

    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.text).toContain("delete from encrypted_credential");
    expect(database.calls[0]?.text).toContain("where space_id = $1 and name = $2");
    expect(database.calls[0]?.values).toEqual(["space-1", "model-key"]);
  });

  it("fails the list rather than hiding a row it cannot decrypt", async () => {
    const database = fakeDatabase(() => [{ ...row("alpha"), envelope: row("other").envelope }]);
    const store = createEncryptedCredentialStore(operator, database, keys);

    await expect(store.list()).rejects.toBeInstanceOf(CredentialStoreError);
  });

  it("rotates only the rows still under an old key and writes them under the active one", async () => {
    const stale = encryptCredentialValue(
      keyring("k1", [["k1", 1]]),
      { spaceId: "space-1", name: "stale" },
      secret,
    );
    const database = fakeDatabase(({ text }) =>
      isSelect(text) ? [{ ...row("stale"), envelope: stale }, row("active")] : [],
    );
    const store = createEncryptedCredentialStore(operator, database, keys);
    const rotation = await store.rotate();
    const updates = database.calls.filter(({ text }) => isRotateUpdate(text));

    expect(rotation).toEqual({ activeKeyId: "k2", reencrypted: 1, total: 2 });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values[1]).toBe("row-stale");
    expect(updates[0]?.values[2]).toBe("space-1");

    const rewritten = String(updates[0]?.values[0]);

    expect(rewritten.startsWith("v1:k2:")).toBe(true);
    expect(decryptCredentialValue(keys, { spaceId: "space-1", name: "stale" }, rewritten)).toBe(
      secret,
    );
  });

  it("is idempotent when every row is already on the active key", async () => {
    const database = fakeDatabase(({ text }) => (isSelect(text) ? [row("alpha")] : []));
    const store = createEncryptedCredentialStore(operator, database, keys);

    await expect(store.rotate()).resolves.toEqual({
      activeKeyId: "k2",
      reencrypted: 0,
      total: 1,
    });
    expect(database.calls.filter(({ text }) => isRotateUpdate(text))).toEqual([]);
  });
});

describe("the job's half", () => {
  it("resolves through the job's space and cannot enumerate or write", async () => {
    const database = fakeDatabase(({ text }) =>
      isResolve(text) ? [{ envelope: row("model-key").envelope }] : [],
    );
    const store = createEncryptedCredentialStore(worker, database, keys);

    await expect(store.resolve("model-key")).resolves.toBe(secret);
    expect(database.calls[0]?.values).toEqual(["space-1", "model-key"]);
    expect("list" in store).toBe(false);
    expect("store" in store).toBe(false);
    expect("rotate" in store).toBe(false);
  });
});

describe("the known key shape never escapes", () => {
  it("is redacted from a log line that names the credential field", () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "credential-secrecy-test",
      write: (line) => lines.push(line),
    });

    logger.info("stored a credential", { credential: secret, name: "model-key" });

    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).toContain(redactedPlaceholder);
  });

  it("is redacted from the event recorder that feeds the durable timeline", () => {
    const recorder = createRunEventRecorder();
    const recorded = recorder.record({
      schemaVersion: 1,
      type: "tool.failed",
      seq: 1,
      threadId: "thread-1",
      runId: "run-1",
      callId: "call-1",
      error: `the provider rejected ${secret}`,
    });

    expect(recorded.type).toBe("tool.failed");
    expect("error" in recorded ? recorded.error : "").not.toContain(secret);
    expect(JSON.stringify(recorded)).not.toContain(secret);
  });
});
