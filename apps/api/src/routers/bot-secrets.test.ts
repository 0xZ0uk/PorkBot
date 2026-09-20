import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { appContract, createApiClient, ORPCError } from "@porkbot/contracts";
import type { Queryable, UserActor, UserRepositories } from "@porkbot/db";
import { createBotSecretStore, createCredentialKeyring, decryptCredentialValue } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp, serviceName } from "../app.ts";
import type { ApiServices } from "../app.ts";
import { createApiServer } from "../server.ts";

/**
 * The bot-secret surface through the real transport (slice 9.6). The typed
 * client lists names, destinations and statuses; a write stores the value
 * encrypted and answers no value; a write that re-points a stored value at
 * another origin is the contract's typed 409; a bot in another space is the
 * shared 404; and the contract walk at the end proves no response body in the
 * tree carries the known key shape.
 *
 * The repositories wrap the real bot-secret store over a recording fake
 * database, so the cipher, the destination check and the handler run together;
 * `@porkbot/db`'s own suite covers the same module against the same shapes.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const botId = "00000000-0000-4000-8000-000000000001";
const secret = "sk-live-0123456789abcdef";
const name = "example_api";
const origin = "https://api.example.test";
const now = new Date("2026-09-19T10:00:00.000Z");

const keyring = createCredentialKeyring({
  activeKeyId: "k1",
  keys: [{ id: "k1", key: Buffer.alloc(32, 7).toString("base64") }],
});

interface FakeRow {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly auth: unknown;
  readonly envelope: string | null;
  readonly forgottenAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "secret-1",
    name,
    origin,
    auth: { type: "bearer" },
    envelope: null,
    forgottenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface RecordingDatabase extends Queryable {
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[];
  rows: readonly FakeRow[];
  existing: readonly {
    readonly origin: string;
    readonly auth: unknown;
    readonly envelope: string | null;
  }[];
  botExists: boolean;
}

function recordingDatabase(): RecordingDatabase {
  const database: RecordingDatabase = {
    calls: [],
    rows: [row()],
    existing: [],
    botExists: true,
    async query<Row>(text: string, values: readonly unknown[] = []) {
      database.calls.push({ text, values });

      if (text.startsWith("select id from bot where")) {
        return { rows: (database.botExists ? [{ id: botId }] : []) as unknown as readonly Row[] };
      }

      if (text.startsWith("select origin, auth, envelope from bot_secret")) {
        return { rows: database.existing as unknown as readonly Row[] };
      }

      if (text.startsWith("insert into bot_secret")) {
        return { rows: [row({ envelope: String(values[5]) })] as unknown as readonly Row[] };
      }

      if (text.startsWith("update bot_secret set envelope = null")) {
        return { rows: [row()] as unknown as readonly Row[] };
      }

      return { rows: database.rows as unknown as readonly Row[] };
    },
  };

  return database;
}

function repositoriesWith(database: Queryable, actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the bot secrets suite");
  };

  return {
    actor,
    membership: { requireActive: notExercised },
    approvals: { decide: notExercised, listForRun: notExercised, list: notExercised },
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
    files: {
      createAttachment: notExercised,
      findAttachments: notExercised,
      findStoredFile: notExercised,
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
    credentials: {
      resolve: notExercised,
      list: notExercised,
      store: notExercised,
      rotate: notExercised,
      remove: notExercised,
    },
    botSecrets: createBotSecretStore(actor, database, keyring),
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
    modelConnections: {
      findById: notExercised,
      list: notExercised,
      create: notExercised,
      update: notExercised,
      setDefault: notExercised,
      delete: notExercised,
      markUsed: notExercised,
    },
    memory: {
      list: notExercised,
      find: notExercised,
      listDeleted: notExercised,
      revisions: notExercised,
      write: notExercised,
      restore: notExercised,
    },
    usage: { forBot: notExercised },
  };
}

const services: ApiServices = {
  deployment: {
    async status() {
      return { kind: "open" } as const;
    },
    async ownership() {
      return { kind: "configured", ownerEmail: null } as const;
    },
  },
  realtime: new InProcessRealtimeFanout(),
};

const lines: string[] = [];
const logger = createLogger({ service: serviceName, write: (line) => lines.push(line) });

let sessionActor: UserActor | null = owner;
let database = recordingDatabase();
const server = createApiServer({
  services,
  logger,
  resolveActor: async () => sessionActor,
  repositoriesFor: (actor) => repositoriesWith(database, actor),
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

describe("the bot secret surface", () => {
  it("lists names, destinations and statuses and never a value", async () => {
    sessionActor = owner;
    lines.length = 0;
    database = recordingDatabase();

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const answer = await client.botSecrets.list({ botId });

    expect(answer.secrets).toEqual([
      {
        name,
        status: "forgotten",
        origin,
        auth: { type: "bearer" },
        createdAt: "2026-09-19T10:00:00.000Z",
        updatedAt: "2026-09-19T10:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("stores the value encrypted and answers no plaintext", async () => {
    sessionActor = owner;
    lines.length = 0;
    database = recordingDatabase();

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const answer = await client.botSecrets.put({
      botId,
      name,
      value: secret,
      origin,
      auth: { type: "bearer" },
    });
    const insert = database.calls.find(({ text }) => text.startsWith("insert into bot_secret"));

    expect(answer).toMatchObject({ name, status: "stored", origin });
    expect(JSON.stringify(answer)).not.toContain(secret);
    expect(insert?.values).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);

    const envelope = String(insert?.values[5]);

    expect(decryptCredentialValue(keyring, { spaceId: "space-1", botId, name }, envelope)).toBe(
      secret,
    );
  });

  it("refuses a write that re-points a stored value at another origin", async () => {
    sessionActor = owner;
    database = recordingDatabase();
    database.existing = [
      {
        origin,
        auth: { type: "bearer" },
        envelope: "v1:k1:placeholder",
      },
    ];

    const app = createApiApp({
      services,
      logger,
      resolveActor: async () => owner,
      repositoriesFor: (actor) => repositoriesWith(database, actor),
    });
    const response = await app.request("/rpc/botSecrets/put", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: {
          botId,
          name,
          value: secret,
          origin: "https://collect.example.invalid",
          auth: { type: "bearer" },
        },
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({ json: { code: "CONFLICT", status: 409 } });
    expect(body).not.toContain(secret);
  });

  it("forgets a secret and reports whether a value was cleared", async () => {
    sessionActor = owner;
    database = recordingDatabase();

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const answer = await client.botSecrets.remove({ botId, name });

    expect(answer).toEqual({ name, removed: true });
    expect(
      database.calls.some(({ text }) => text.startsWith("update bot_secret set envelope = null")),
    ).toBe(true);
  });

  it("answers the shared 404 for a bot in another space", async () => {
    sessionActor = owner;
    database = recordingDatabase();
    database.botExists = false;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.botSecrets.list({ botId }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, defined: true });
  });

  it("answers the typed 401 without a session", async () => {
    sessionActor = null;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.botSecrets.list({ botId }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
  });
});

describe("no endpoint returns the value", () => {
  it("walks every contract procedure and finds the key shape in no response", async () => {
    sessionActor = owner;
    lines.length = 0;
    database = recordingDatabase();

    const app = createApiApp({
      services,
      logger,
      resolveActor: async () => owner,
      repositoriesFor: (actor) => repositoriesWith(database, actor),
    });
    const leaves = contractLeaves(appContract as unknown as Record<string, unknown>);

    for (const leaf of leaves) {
      const response = await app.request(`/rpc/${leaf}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-client": leaf },
        body: "{}",
      });
      const contentType = response.headers.get("content-type") ?? "";

      // A subscription holds the connection open; it never carries a stored
      // bot secret, and the procedure calls below are where a value could
      // appear.
      if (contentType.includes("text/event-stream")) {
        continue;
      }

      const body = await response.text();

      expect(body, `${leaf} returned the bot secret value`).not.toContain(secret);
    }

    expect(lines.join("\n")).not.toContain(secret);
  });
});

/** The contract's procedure paths, flattened the way the access suite walks them. */
function contractLeaves(node: unknown, prefix: string[] = []): string[] {
  if (typeof node !== "object" || node === null) {
    return [];
  }

  const record = node as Record<string, unknown>;

  if (typeof record["~orpc"] === "object" && record["~orpc"] !== null) {
    return [prefix.join("/")];
  }

  return Object.entries(record).flatMap(([key, value]) => contractLeaves(value, [...prefix, key]));
}
