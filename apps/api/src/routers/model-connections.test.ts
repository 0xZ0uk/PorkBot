import { randomUUID } from "node:crypto";
import {
  createOpenAiCompatibleModelRuntime,
  InProcessRealtimeFanout,
  ModelEmulator,
} from "@porkbot/adapters";
import type { ModelEmulatorScript } from "@porkbot/adapters";
import { createApiClient, ORPCError } from "@porkbot/contracts";
import { NameConflictError, NotFoundError } from "@porkbot/effect";
import { createCredentialKeyring, createEncryptedCredentialStore } from "@porkbot/db";
import type {
  ModelConnectionPatch,
  ModelConnectionRecord,
  NewModelConnection,
  Queryable,
  UserActor,
  UserRepositories,
} from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ApiServices } from "../app.ts";
import { createApiServer, serviceName } from "../server.ts";

/**
 * The model connection surface through the real transport, with the shipped
 * OpenAI-compatible adapter pointed at the offline emulator over loopback: the
 * operator connects an endpoint by URL and stored credential name, the list
 * answers with the store's mask and never the value, and the probe reports
 * what the endpoint actually did — reachability, models, streaming — with a
 * classified refusal shown as data and a missing credential left as the typed
 * precondition the gate answers.
 *
 * The connection repository is an in-memory fake that enforces the same
 * scoping the SQL repository does (a foreign-space id is `NotFoundError`),
 * because this suite tests the transport projection and the probe
 * orchestration; the SQL semantics are proven against Postgres in `@porkbot/db`.
 * The credential store is the real encrypted one over a small fake driver, so
 * a key stored through `credentials.store` is the key the probe resolves, and
 * the mask in every response is the store's own.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const strangerSpace = "space-other";
const secret = "sk-live-0123456789abcdef";

const keyring = createCredentialKeyring({
  activeKeyId: "test-key",
  keys: [{ id: "test-key", key: Buffer.alloc(32, 9).toString("base64") }],
});

interface CredentialRow {
  readonly id: string;
  readonly name: string;
  readonly envelope: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const credentialRows = new Map<string, CredentialRow>();
const connections = new Map<string, ModelConnectionRecord>();
const openEmulators: ModelEmulator[] = [];

let sessionActor: UserActor | null = owner;

/**
 * The encrypted store's own queries served from one map: the resolve, the
 * masked list and the encrypting upsert. The cipher and the mask are the
 * shipped ones; only the driver is fake.
 */
function credentialDatabase(): Queryable {
  return {
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      if (text.includes("insert into encrypted_credential")) {
        const [spaceId, name, envelope] = values as [string, string, string];
        const key = `${spaceId}:${name}`;
        const existing = credentialRows.get(key);
        const row: CredentialRow = {
          id: existing?.id ?? `credential-${name}`,
          name,
          envelope,
          createdAt: existing?.createdAt ?? new Date(0),
          updatedAt: new Date(0),
        };
        credentialRows.set(key, row);

        return { rows: [row] as unknown as readonly Row[] };
      }

      if (text.includes("from encrypted_credential")) {
        const [spaceId, name] = values as [string, string?];
        const rows = [...credentialRows.entries()]
          .filter(([key]) => key.startsWith(`${spaceId}:`))
          .map(([, row]) => row)
          .filter((row) => name === undefined || row.name === name);

        return { rows: rows as unknown as readonly Row[] };
      }

      return { rows: [] as readonly Row[] };
    },
  };
}

function credentialsFor(actor: UserActor) {
  return createEncryptedCredentialStore(actor, credentialDatabase(), keyring);
}

function definedOnly(patch: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function modelConnectionRepository(actor: UserActor) {
  const inSpace = (): readonly ModelConnectionRecord[] =>
    [...connections.values()].filter((record) => record.spaceId === actor.spaceId);

  async function findScoped(id: string): Promise<ModelConnectionRecord> {
    const record = connections.get(id);

    if (record === undefined || record.spaceId !== actor.spaceId) {
      throw new NotFoundError("model connection", id);
    }

    return record;
  }

  return {
    findById: findScoped,
    async list() {
      return [...inSpace()].sort((left, right) =>
        left.isDefault === right.isDefault
          ? left.label.localeCompare(right.label)
          : Number(right.isDefault) - Number(left.isDefault),
      );
    },
    async create(input: NewModelConnection) {
      if (inSpace().some((record) => record.label === input.label)) {
        throw new NameConflictError("model connection", input.label);
      }

      const now = new Date();
      const record: ModelConnectionRecord = {
        id: randomUUID(),
        spaceId: actor.spaceId,
        label: input.label,
        baseUrl: input.baseUrl,
        credentialName: input.credentialName,
        defaultModel: input.defaultModel ?? null,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };
      connections.set(record.id, record);
      return record;
    },
    async update(id: string, patch: ModelConnectionPatch) {
      const record = await findScoped(id);
      const next = { ...record, ...definedOnly(patch), updatedAt: new Date() };
      connections.set(id, next);
      return next;
    },
    async setDefault(id: string) {
      const target = await findScoped(id);

      for (const [key, record] of connections) {
        if (record.spaceId === target.spaceId && record.isDefault && key !== id) {
          connections.set(key, { ...record, isDefault: false, updatedAt: new Date() });
        }
      }

      const next = { ...target, isDefault: true, updatedAt: new Date() };
      connections.set(id, next);
      return next;
    },
    async delete(id: string) {
      const record = await findScoped(id);
      connections.delete(id);
      return record;
    },
  };
}

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the model connections suite");
  };

  return {
    actor,
    membership: { requireActive: notExercised },
    bots: {
      findById: notExercised,
      list: notExercised,
      create: notExercised,
      update: notExercised,
      archive: notExercised,
      restore: notExercised,
      delete: notExercised,
      setAvatar: notExercised,
    },
    sections: {
      list: notExercised,
      create: notExercised,
      update: notExercised,
      delete: notExercised,
    },
    threads: {
      findById: notExercised,
      listForBot: notExercised,
      createForBot: notExercised,
      clear: notExercised,
    },
    runs: {
      findById: notExercised,
      listForThread: notExercised,
      findActiveForThread: notExercised,
      create: notExercised,
      requestStop: notExercised,
    },
    events: { listAfter: notExercised },
    messages: {
      listForThread: notExercised,
      findByNonce: notExercised,
      steer: notExercised,
    },
    computerSnapshots: { create: notExercised, findById: notExercised, listForBot: notExercised },
    toolResults: { read: notExercised },
    routines: {
      findById: notExercised,
      list: notExercised,
      listForBot: notExercised,
      outcomes: notExercised,
      lastOutcome: notExercised,
      preview: notExercised,
      create: notExercised,
      update: notExercised,
      remove: notExercised,
      testRun: notExercised,
    },
    notifications: { read: notExercised, set: notExercised },
    credentials: credentialsFor(actor),
    modelConnections: modelConnectionRepository(actor),
    memory: {
      list: notExercised,
      find: notExercised,
      listDeleted: notExercised,
      revisions: notExercised,
      write: notExercised,
      restore: notExercised,
    },
    mcp: {
      list: notExercised,
      findById: notExercised,
      create: notExercised,
      setStatus: notExercised,
      replaceTools: notExercised,
      remove: notExercised,
      grant: notExercised,
      revoke: notExercised,
      listForServer: notExercised,
    },
  };
}

const lines: string[] = [];
const logger = createLogger({ service: serviceName, write: (line) => lines.push(line) });

const services: ApiServices = {
  deployment: {
    async status() {
      return { kind: "open" } as const;
    },
  },
  realtime: new InProcessRealtimeFanout(),
  modelRuntime: (credentials) =>
    createOpenAiCompatibleModelRuntime({ credentials, fetch: globalThis.fetch }),
};

const server = createApiServer({
  services,
  logger,
  resolveActor: async () => sessionActor,
  repositoriesFor,
});
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

afterEach(async () => {
  connections.clear();
  credentialRows.clear();
  sessionActor = owner;
  await Promise.all(openEmulators.splice(0).map((emulator) => emulator.stop()));
});

async function startEmulator(script: ModelEmulatorScript): Promise<ModelEmulator> {
  const emulator = await ModelEmulator.start(script, globalThis.fetch);
  openEmulators.push(emulator);
  return emulator;
}

function client() {
  return createApiClient({ url: `${baseUrl}/rpc` });
}

/** Stores a secret through the shipped encrypted store, as the operator would. */
async function storeSecret(name: string, value: string): Promise<void> {
  await credentialsFor(owner).store(name, value);
}

async function connect(credentialName = "model-key", emulator?: ModelEmulator) {
  const answer = await client().modelConnections.create({
    label: "Local models",
    baseUrl: emulator?.baseUrl ?? "https://model.example.invalid/v1",
    credentialName,
    defaultModel: "fixture-model",
  });

  return answer;
}

describe("the connection surface", () => {
  it("shows the store's mask and never the value", async () => {
    await storeSecret("model-key", secret);

    const created = await connect();
    const list = await client().modelConnections.list();

    expect(created.credentialMaskedValue).toBe(`••••${secret.slice(-4)}`);
    expect(list.connections).toEqual([created]);
    expect(JSON.stringify({ created, list })).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("reports a label already in the space as the typed conflict", async () => {
    await storeSecret("model-key", secret);
    await connect();

    const error = await client()
      .modelConnections.create({
        label: "Local models",
        baseUrl: "https://model.example.invalid/v1",
        credentialName: "model-key",
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "CONFLICT", status: 409, defined: true });
  });

  it("swaps the space default and removes a connection", async () => {
    await storeSecret("model-key", secret);
    const first = await connect();
    const second = await client().modelConnections.create({
      label: "Second endpoint",
      baseUrl: "https://other.example.invalid/v1",
      credentialName: "model-key",
    });

    expect(first.isDefault).toBe(false);

    const chosen = await client().modelConnections.setDefault({ id: second.id });
    expect(chosen.isDefault).toBe(true);

    const removed = await client().modelConnections.remove({ id: second.id });
    expect(removed.id).toBe(second.id);
    await expect(client().modelConnections.list()).resolves.toMatchObject({
      connections: [{ id: first.id }],
    });
  });

  it("answers a connection outside the actor's space as not found", async () => {
    const foreign: ModelConnectionRecord = {
      id: randomUUID(),
      spaceId: strangerSpace,
      label: "Not mine",
      baseUrl: "https://foreign.example.invalid/v1",
      credentialName: "model-key",
      defaultModel: null,
      isDefault: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    connections.set(foreign.id, foreign);

    const error = await client()
      .modelConnections.setDefault({ id: foreign.id })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, defined: true });
  });
});

describe("the probe", () => {
  it("reports reachability, models and streaming from the live endpoint", async () => {
    const emulator = await startEmulator({
      apiKey: secret,
      models: ["fixture-model", "fallback-model"],
      turns: [],
    });
    await storeSecret("model-key", secret);
    const connection = await connect("model-key", emulator);

    await expect(client().modelConnections.probe({ id: connection.id })).resolves.toEqual({
      connectionId: connection.id,
      probe: {
        reachable: true,
        models: [{ id: "fixture-model" }, { id: "fallback-model" }],
        streaming: true,
        failure: null,
      },
    });
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("reports a non-streaming endpoint honestly", async () => {
    const emulator = await startEmulator({
      apiKey: secret,
      models: ["fixture-model"],
      streaming: false,
      turns: [],
    });
    await storeSecret("model-key", secret);
    const connection = await connect("model-key", emulator);

    await expect(client().modelConnections.probe({ id: connection.id })).resolves.toMatchObject({
      probe: { reachable: true, streaming: false, failure: null },
    });
  });

  it("shows a classified refusal as data", async () => {
    const emulator = await startEmulator({ apiKey: "sk-the-server-expects", turns: [] });
    await storeSecret("model-key", secret);
    const connection = await connect("model-key", emulator);

    await expect(client().modelConnections.probe({ id: connection.id })).resolves.toMatchObject({
      probe: { reachable: false, models: [], streaming: false, failure: "auth_failed" },
    });
  });

  it("answers a credential the store does not hold as the typed precondition", async () => {
    const emulator = await startEmulator({ models: ["fixture-model"], turns: [] });
    const connection = await connect("missing-key", emulator);

    const error = await client()
      .modelConnections.probe({ id: connection.id })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "PRECONDITION_FAILED", status: 412, defined: true });
  });
});
