import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient } from "@porkbot/contracts";
import type { AppClient } from "@porkbot/contracts";
import type {
  MemoryDocuments,
  MemoryRevisionRecord,
  UserActor,
  UserRepositories,
} from "@porkbot/db";
import { UnknownMemoryDocument, UnknownMemoryRevision } from "@porkbot/core";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { serviceName } from "../app.ts";
import type { ApiServices } from "../app.ts";
import { createApiServer } from "../server.ts";
import type { DeploymentStatus } from "../services/deployment.ts";

/**
 * The memory router over the real transport: a scripted store stands in for the
 * database, so what this suite proves is the router's own contract — the
 * actor's scope is the store's (no input names a space), the records map to
 * exactly the wire shape `@porkbot/contracts` declares, a decision travels as
 * the outcome union rather than an exception, and restore is one call on the
 * store rather than a read-then-write the router composes. The statements
 * themselves are `@porkbot/db`'s suites' proof.
 */

const lines: string[] = [];
const logger: Logger = createLogger({
  service: serviceName,
  write: (line) => lines.push(line),
});

const services: ApiServices = {
  deployment: {
    async status(): Promise<DeploymentStatus> {
      return { kind: "open" };
    },
  },
  realtime: new InProcessRealtimeFanout(),
};

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };

const firstRevision: MemoryRevisionRecord = {
  documentId: "doc-1",
  revision: 1,
  origin: "deliberate",
  author: "user-1",
  reason: "operator correction",
  kind: "fact",
  title: "Preferred editor",
  content: "The operator prefers keyboard-driven editing.",
  deleted: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const secondRevision: MemoryRevisionRecord = {
  documentId: "doc-1",
  revision: 2,
  origin: "agent_proposed",
  author: "bot-1",
  reason: "learned in a run",
  kind: "fact",
  title: "Preferred editor",
  content: "The operator prefers Neovim.",
  deleted: false,
  createdAt: "2026-01-02T00:00:00.000Z",
};

const revisions: readonly MemoryRevisionRecord[] = [firstRevision, secondRevision];

type MemoryStoreStub = {
  readonly [K in keyof MemoryDocuments]: Mock<MemoryDocuments[K]>;
};

function memoryStore(): MemoryStoreStub {
  return {
    list: vi.fn<MemoryDocuments["list"]>(async () => [
      {
        documentId: "doc-1",
        kind: "fact",
        title: "Preferred editor",
        content: "The operator prefers keyboard-driven editing.",
        revision: 2,
      },
    ]),
    find: vi.fn<MemoryDocuments["find"]>(),
    listDeleted: vi.fn<MemoryDocuments["listDeleted"]>(async () => [
      {
        documentId: "doc-1",
        kind: "fact",
        title: "Preferred editor",
        content: "The operator prefers Neovim.",
        revision: 3,
        deletedAt: "2026-01-03T00:00:00.000Z",
      },
    ]),
    revisions: vi.fn<MemoryDocuments["revisions"]>(async () => revisions),
    write: vi.fn<MemoryDocuments["write"]>(async () => ({
      ok: true as const,
      action: "update" as const,
      revision: secondRevision,
    })),
    restore: vi.fn<MemoryDocuments["restore"]>(async () => ({
      ok: true as const,
      action: "restore" as const,
      revision: { ...firstRevision, revision: 3 },
    })),
  };
}

function stubRepositories(memory: MemoryStoreStub): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the memory router suite");
  };

  return {
    actor: owner,
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
    credentials: {
      resolve: notExercised,
      list: notExercised,
      store: notExercised,
      rotate: notExercised,
      remove: notExercised,
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
    memory,
    usage: { forBot: notExercised },
  };
}

let memory: MemoryStoreStub;
let repositories: UserRepositories;

const server = createApiServer({
  services,
  logger,
  resolveActor: async () => owner,
  repositoriesFor: () => repositories,
});

let client: AppClient;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  client = createApiClient({ url: `http://127.0.0.1:${address.port}/rpc` });
});

beforeEach(() => {
  lines.length = 0;
  memory = memoryStore();
  repositories = stubRepositories(memory);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

describe("listing memory", () => {
  it("returns live documents with no tombstone instant", async () => {
    const listed = await client.memory.list({ botId: "bot-1" });

    expect(memory.list).toHaveBeenCalledWith("bot-1");
    expect(memory.listDeleted).not.toHaveBeenCalled();
    expect(listed).toEqual({
      documents: [
        {
          documentId: "doc-1",
          kind: "fact",
          title: "Preferred editor",
          content: "The operator prefers keyboard-driven editing.",
          revision: 2,
          deletedAt: null,
        },
      ],
    });
  });

  it("returns tombstoned documents under the deleted scope", async () => {
    const listed = await client.memory.list({ botId: "bot-1", scope: "deleted" });

    expect(memory.listDeleted).toHaveBeenCalledWith("bot-1");
    expect(memory.list).not.toHaveBeenCalled();
    expect(listed).toEqual({
      documents: [
        {
          documentId: "doc-1",
          kind: "fact",
          title: "Preferred editor",
          content: "The operator prefers Neovim.",
          revision: 3,
          deletedAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
  });
});

describe("reading history", () => {
  it("returns the whole history with who, why and when", async () => {
    const history = await client.memory.revisions({ botId: "bot-1", documentId: "doc-1" });

    expect(memory.revisions).toHaveBeenCalledWith("bot-1", "doc-1");
    expect(history.revisions).toEqual(revisions);
    expect(history.revisions[1]?.origin).toBe("agent_proposed");
    expect(history.revisions[1]?.author).toBe("bot-1");
  });
});

describe("editing and removing memory", () => {
  it("passes the correction to the store and returns the persisted revision", async () => {
    const outcome = await client.memory.update({
      botId: "bot-1",
      documentId: "doc-1",
      title: "Preferred editor",
      content: "The operator prefers Neovim.",
      reason: "operator correction",
    });

    expect(memory.write).toHaveBeenCalledWith("bot-1", {
      write: {
        action: "update",
        documentId: "doc-1",
        title: "Preferred editor",
        content: "The operator prefers Neovim.",
      },
      reason: "operator correction",
    });
    expect(outcome).toEqual({ ok: true, action: "update", revision: secondRevision });
  });

  it("passes a deletion to the store with its reason", async () => {
    memory.write.mockResolvedValueOnce({
      ok: true,
      action: "delete",
      revision: { ...secondRevision, revision: 3, deleted: true },
    });

    const outcome = await client.memory.remove({
      botId: "bot-1",
      documentId: "doc-1",
      reason: "no longer relevant",
    });

    expect(memory.write).toHaveBeenCalledWith("bot-1", {
      write: { action: "delete", documentId: "doc-1" },
      reason: "no longer relevant",
    });
    expect(outcome).toMatchObject({ ok: true, action: "delete", revision: { revision: 3 } });
  });

  it("reports a no-op without a revision", async () => {
    memory.write.mockResolvedValueOnce({ ok: true, action: "no_change" });

    const outcome = await client.memory.update({
      botId: "bot-1",
      documentId: "doc-1",
      title: "Preferred editor",
      content: "The operator prefers keyboard-driven editing.",
      reason: "operator correction",
    });

    expect(outcome).toEqual({ ok: true, action: "no_change" });
  });

  it("carries a domain refusal as the rule and its sentence", async () => {
    memory.write.mockResolvedValueOnce({
      ok: false,
      error: new UnknownMemoryDocument("doc-1"),
    });

    const outcome = await client.memory.update({
      botId: "bot-1",
      documentId: "doc-1",
      title: "Preferred editor",
      content: "Vim.",
      reason: "operator correction",
    });

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.rule).toBe("UnknownMemoryDocument");
      expect(outcome.message).toContain("doc-1");
    }
  });
});

describe("restoring a revision", () => {
  it("calls the store's restore once rather than composing a read and a write", async () => {
    const outcome = await client.memory.restore({
      botId: "bot-1",
      documentId: "doc-1",
      revision: 1,
      reason: "put it back",
    });

    expect(memory.restore).toHaveBeenCalledWith("bot-1", "doc-1", 1, "put it back");
    expect(memory.write).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: true, action: "restore", revision: { revision: 3 } });
  });

  it("carries an unknown revision as a typed refusal", async () => {
    memory.restore.mockResolvedValueOnce({
      ok: false,
      error: new UnknownMemoryRevision("doc-1", 9),
    });

    const outcome = await client.memory.restore({
      botId: "bot-1",
      documentId: "doc-1",
      revision: 9,
      reason: "put it back",
    });

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.rule).toBe("UnknownMemoryRevision");
      expect(outcome.message).toContain("revision 9");
    }
  });
});
