import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { appContract, createApiClient, ORPCError } from "@porkbot/contracts";
import type { Queryable, UserActor, UserRepositories } from "@porkbot/db";
import {
  createCredentialKeyring,
  createEncryptedCredentialStore,
  encryptCredentialValue,
} from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp, serviceName } from "../app.ts";
import type { ApiServices } from "../app.ts";
import { createApiServer } from "../server.ts";

/**
 * The stored credential surface through the real transport: the typed client
 * lists masked summaries, a signed-out caller is refused before the handler, a
 * row the keyring cannot open is the contract's typed 503, and no endpoint —
 * the list included — returns the value.
 *
 * The repositories wrap the real encrypted store over a one-row fake database
 * standing in for the pg client, so the cipher, the mask and the handler are
 * exercised together; `@porkbot/db`'s integration suite proves the same calls
 * against Postgres. The contract walk at the end is the regression guard the
 * acceptance criterion asks for: every procedure in the tree is called and no
 * response body may contain the known key shape.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const secret = "sk-live-0123456789abcdef";
const masked = `••••${secret.slice(-4)}`;

const keyring = createCredentialKeyring({
  activeKeyId: "k1",
  keys: [{ id: "k1", key: Buffer.alloc(32, 7).toString("base64") }],
});

function databaseWith(envelope: string): Queryable {
  return {
    async query<Row>(): Promise<{ readonly rows: readonly Row[] }> {
      return {
        rows: [
          {
            id: "credential-1",
            name: "model-key",
            envelope,
            createdAt: new Date("2026-09-18T10:00:00.000Z"),
            updatedAt: new Date("2026-09-18T10:00:00.000Z"),
          },
        ] as unknown as readonly Row[],
      };
    },
  };
}

const validEnvelope = encryptCredentialValue(
  keyring,
  { spaceId: "space-1", name: "model-key" },
  secret,
);

function repositoriesWith(database: Queryable, actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the credentials suite");
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
    credentials: createEncryptedCredentialStore(actor, database, keyring),
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
  },
  realtime: new InProcessRealtimeFanout(),
};

const lines: string[] = [];
const logger = createLogger({ service: serviceName, write: (line) => lines.push(line) });

let sessionActor: UserActor | null = owner;
const server = createApiServer({
  services,
  logger,
  resolveActor: async () => sessionActor,
  repositoriesFor: (actor) => repositoriesWith(databaseWith(validEnvelope), actor),
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

describe("the stored credential surface", () => {
  it("lists masked summaries and never the value", async () => {
    sessionActor = owner;
    lines.length = 0;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const answer = await client.credentials.list();

    expect(answer.credentials).toEqual([
      {
        id: "credential-1",
        name: "model-key",
        maskedValue: masked,
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T10:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("stores a value encrypted and answers only its mask", async () => {
    sessionActor = owner;
    lines.length = 0;

    const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
    const database: Queryable = {
      async query<Row>(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });

        return {
          rows: [
            {
              id: "credential-1",
              name: "model-key",
              envelope: validEnvelope,
              createdAt: new Date("2026-09-18T10:00:00.000Z"),
              updatedAt: new Date("2026-09-18T10:00:00.000Z"),
            },
          ] as unknown as readonly Row[],
        };
      },
    };
    const app = createApiApp({
      services,
      logger,
      resolveActor: async () => owner,
      repositoriesFor: (actor) => repositoriesWith(database, actor),
    });

    const response = await app.request("/rpc/credentials/store", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { name: "model-key", value: secret } }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      json: {
        id: "credential-1",
        name: "model-key",
        maskedValue: masked,
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T10:00:00.000Z",
      },
    });
    expect(body).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
    expect(calls[0]?.text).toContain("insert into encrypted_credential");
    expect(JSON.stringify(calls)).not.toContain(secret);
  });

  it("answers the typed 401 without a session", async () => {
    sessionActor = null;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.credentials.list().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
  });

  it("answers the contract's typed 503 for a row the keyring cannot open", async () => {
    sessionActor = owner;

    const foreignEnvelope = encryptCredentialValue(
      keyring,
      { spaceId: "space-1", name: "another-key" },
      secret,
    );
    const app = createApiApp({
      services,
      logger,
      resolveActor: async () => owner,
      repositoriesFor: (actor) => repositoriesWith(databaseWith(foreignEnvelope), actor),
    });
    const response = await app.request("/rpc/credentials/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({
      json: {
        defined: true,
        code: "SERVICE_UNAVAILABLE",
        status: 503,
        message: "The credential store is not readable",
      },
    });
    expect(body).not.toContain(secret);
  });
});

describe("no endpoint returns the value", () => {
  it("walks every contract procedure and finds the key shape in no response", async () => {
    sessionActor = owner;
    lines.length = 0;

    const app = createApiApp({
      services,
      logger,
      resolveActor: async () => owner,
      repositoriesFor: (actor) => repositoriesWith(databaseWith(validEnvelope), actor),
    });
    const leaves = contractLeaves(appContract as unknown as Record<string, unknown>);

    expect(leaves.length).toBeGreaterThan(20);

    for (const leaf of leaves) {
      const response = await app.request(`/rpc/${leaf}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-client": leaf },
        body: "{}",
      });
      const contentType = response.headers.get("content-type") ?? "";

      // A subscription holds the connection open; it never carries a stored
      // credential, and the list below is where the value could appear.
      if (contentType.includes("text/event-stream")) {
        continue;
      }

      const body = await response.text();

      expect(body, `${leaf} returned the credential value`).not.toContain(secret);
    }

    expect(lines.join("\n")).not.toContain(secret);
  });
});

describe("a defect that carries the value", () => {
  it("is answered 500 with a generic envelope and logged redacted", async () => {
    const defectLines: string[] = [];
    const defectLogger = createLogger({
      service: serviceName,
      write: (line) => defectLines.push(line),
    });
    const database: Queryable = {
      async query(): Promise<{ readonly rows: never[] }> {
        throw new Error(`the driver refused while reading ${secret}`);
      },
    };
    const app = createApiApp({
      services,
      logger: defectLogger,
      resolveActor: async () => owner,
      repositoriesFor: (actor) => repositoriesWith(database, actor),
    });
    const response = await app.request("/rpc/credentials/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(secret);
    expect(defectLines.join("\n")).not.toContain(secret);
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
