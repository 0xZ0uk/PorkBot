import { randomUUID } from "node:crypto";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import type {
  StorageBody,
  StorageObject,
  StorageProvider,
  StoragePutRequest,
} from "@porkbot/adapter-kit";
import type { MessageAttachmentRecord, UserActor, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceName } from "./app.ts";
import { createApiServer } from "./server.ts";

/**
 * The stored-file routes (slice 7.6, stories 32 and 33): the raw upload and
 * download surfaces over a real HTTP listener.
 *
 * The upload streams its body into the storage seam — the test sends it in
 * chunks and reads the reconstructed object back — and the download resolves
 * the id through the actor-scoped store and streams the object with its stored
 * name. The size cap is the `upload` family's, refused before the body is
 * read; a missing session is the same 401 the gate answers everywhere; and a
 * foreign or unknown id is the shared 404 rather than a storage key leak.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const threadId = "00000000-0000-4000-8000-000000000001";

class MemoryStorage implements StorageProvider {
  readonly objects = new Map<string, { readonly bytes: Buffer; readonly contentType?: string }>();

  async put(request: StoragePutRequest): Promise<StorageObject> {
    const chunks: Buffer[] = [];

    for await (const chunk of request.body) {
      chunks.push(Buffer.from(chunk));
    }

    const bytes = Buffer.concat(chunks);
    this.objects.set(request.key, {
      bytes,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    });

    return {
      key: request.key,
      size: bytes.byteLength,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
      lastModified: new Date(0).toISOString(),
    };
  }

  async get(key: string): Promise<StorageBody | undefined> {
    const stored = this.objects.get(key);

    if (stored === undefined) {
      return undefined;
    }

    const bytes = stored.bytes;

    return {
      object: {
        key,
        size: bytes.byteLength,
        ...(stored.contentType === undefined ? {} : { contentType: stored.contentType }),
        lastModified: new Date(0).toISOString(),
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    };
  }

  async delete(key: string): Promise<boolean> {
    return this.objects.delete(key);
  }

  async list(): Promise<readonly StorageObject[]> {
    return [];
  }
}

const storage = new MemoryStorage();
const attachments = new Map<string, MessageAttachmentRecord>();

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the stored-file suite");
  };

  const known: Partial<UserRepositories> = {
    actor,
    files: {
      async createAttachment(input) {
        if (input.threadId !== threadId || actor.spaceId !== owner.spaceId) {
          throw new NotFoundError("thread", input.threadId);
        }

        const record: MessageAttachmentRecord = {
          id: randomUUID(),
          spaceId: actor.spaceId,
          threadId: input.threadId,
          botId: "bot-1",
          userId: actor.userId,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          storageKey: input.storageKey,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };

        attachments.set(record.id, record);

        return record;
      },
      async findAttachments(threadId, ids) {
        return ids.map((id) => {
          const record = attachments.get(id);

          if (record === undefined || record.threadId !== threadId) {
            throw new NotFoundError("attachment", id);
          }

          return record;
        });
      },
      async findStoredFile(id) {
        const record = attachments.get(id);

        if (record === undefined) {
          throw new NotFoundError("file", id);
        }

        return {
          id: record.id,
          filename: record.filename,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          storageKey: record.storageKey,
        };
      },
    },
  };

  return new Proxy(known as unknown as UserRepositories, {
    get(target, property) {
      const value = Reflect.get(target, property);

      return value === undefined ? notExercised : value;
    },
  });
}

const server = createApiServer({
  services: {
    deployment: {
      async status() {
        return { kind: "closed" };
      },
    },
    realtime: new InProcessRealtimeFanout(),
    storage,
  },
  logger: createLogger({ service: serviceName, write: () => undefined }),
  resolveActor: async () => owner,
  repositoriesFor,
  limits: {
    upload: { requestsPerMinute: 100, maxBodyBytes: 1_024 },
  },
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

function uploadUrl(thread = threadId, filename = "report.txt"): string {
  return `${baseUrl}/threads/${thread}/attachments?filename=${encodeURIComponent(filename)}`;
}

/** Node's fetch wants `duplex` for a streaming request body; the DOM type omits it. */
type StreamedInit = RequestInit & { readonly duplex: "half" };

/** A body delivered in three chunks, so the route is proven to stream one. */
function streamedBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const third = Math.ceil(bytes.byteLength / 3);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += third) {
        controller.enqueue(bytes.subarray(offset, offset + third));
      }

      controller.close();
    },
  });
}

describe("uploading an attachment", () => {
  it("streams the body into the storage seam and answers the row", async () => {
    const response = await fetch(uploadUrl(), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: streamedBody("hello attachment"),
      duplex: "half",
    } as StreamedInit);

    expect(response.status).toBe(201);
    const uploaded = (await response.json()) as {
      readonly id: string;
      readonly filename: string;
      readonly contentType: string;
      readonly sizeBytes: number;
    };

    expect(uploaded).toMatchObject({
      filename: "report.txt",
      contentType: "text/plain",
      sizeBytes: 16,
    });

    const record = attachments.get(uploaded.id);
    expect(record).toBeDefined();
    expect(storage.objects.get(record?.storageKey ?? "")?.bytes.toString("utf8")).toBe(
      "hello attachment",
    );
  });

  it("strips directories from the file name and defaults an unlabeled type", async () => {
    const response = await fetch(uploadUrl(threadId, "../../etc/passwd"), {
      method: "POST",
      headers: { "content-type": "" },
      body: streamedBody("x"),
      duplex: "half",
    } as StreamedInit);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      filename: "passwd",
      contentType: "application/octet-stream",
    });
  });

  it("refuses an oversized body with the upload family's cap before parsing it", async () => {
    const response = await fetch(uploadUrl(), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: new Uint8Array(2_048),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large" });
  });

  it("requires a file name and a session", async () => {
    const noName = await fetch(`${baseUrl}/threads/thread-1/attachments`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });

    expect(noName.status).toBe(400);
  });

  it("answers a malformed thread id as not-found before any statement runs", async () => {
    const response = await fetch(uploadUrl("not-a-uuid"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "NOT_FOUND" });
  });

  it("refuses an upload without a session", async () => {
    const anonymous = createApiServer({
      services: {
        deployment: {
          async status() {
            return { kind: "closed" };
          },
        },
        realtime: new InProcessRealtimeFanout(),
        storage,
      },
      logger: createLogger({ service: serviceName, write: () => undefined }),
    });

    await new Promise<void>((resolve) => {
      anonymous.listen(0, "127.0.0.1", resolve);
    });

    const address = anonymous.address();

    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/threads/thread-1/attachments?filename=x.txt`,
        { method: "POST", body: "x" },
      );

      expect(response.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        anonymous.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("downloading a stored file", () => {
  it("streams the bytes back with the stored name and type", async () => {
    const uploaded = (await (
      await fetch(uploadUrl(), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: streamedBody("download me"),
        duplex: "half",
      } as StreamedInit)
    ).json()) as { readonly id: string };

    const response = await fetch(`${baseUrl}/files/${uploaded.id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe("11");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="report.txt"; filename*=UTF-8''report.txt`,
    );
    await expect(response.text()).resolves.toBe("download me");
  });

  it("answers an unknown or foreign id as not-found without a storage read", async () => {
    const response = await fetch(`${baseUrl}/files/00000000-0000-4000-8000-000000000000`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "NOT_FOUND" });
  });

  it("answers a malformed file id as not-found before any statement runs", async () => {
    const response = await fetch(`${baseUrl}/files/not-a-uuid`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "NOT_FOUND" });
  });
});
