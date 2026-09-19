import { createServer } from "node:http";
import type { Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { NotFoundError } from "@porkbot/effect";
import type { EventRecord, ThreadRecord, UserActor, UserRepositories } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiServer, rpcPath, serviceName } from "./index.ts";
import type { ApiServices } from "./app.ts";
import { createCursorCodec } from "./cursors.ts";
import type { DeploymentStatus } from "./services/deployment.ts";

/**
 * The resumable subscription over the real HTTP surface (slice 4.3, PRD
 * decisions 14 and 18; story 19; the live revocation check from slice 3.3).
 * Every acceptance criterion has a test here: a dropped connection resumes
 * with no duplicate and no missing event, `Last-Event-ID` is honoured —
 * including through a proxy that preserves it — subscribe and resume both
 * re-validate the actor and the membership, a revoked membership ends a
 * subscription that is already open, and a forged or foreign cursor is a
 * typed refusal rather than a replay.
 *
 * The event rows live in a small in-memory store and the realtime fanout is the
 * shipped in-process implementation, so the tests drive exactly the seam the
 * API will use: persist, then publish, then read. No database is involved
 * because the subject is the transport, not the SQL.
 */

const lines: string[] = [];
const logger: Logger = createLogger({
  service: serviceName,
  write: (line) => lines.push(line),
});

const fanout = new InProcessRealtimeFanout();

const services: ApiServices = {
  deployment: {
    async status(): Promise<DeploymentStatus> {
      return { kind: "open" };
    },
  },
  realtime: fanout,
};

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const member: UserActor = { kind: "user", spaceId: "space-1", userId: "user-2", role: "member" };

const spaceOneThread = "01900000-0000-7000-8000-000000000001";
const spaceTwoThread = "01900000-0000-7000-8000-000000000002";
const siblingThread = "01900000-0000-7000-8000-000000000003";

interface FakeStore {
  readonly threads: Map<string, ThreadRecord>;
  readonly events: EventRecord[];
  /** The `space_member` rows the live membership check re-reads: `space:user`. */
  readonly memberships: Set<string>;
}

let store: FakeStore;
let sessionActor: UserActor | null = owner;

/**
 * A test-only hold inside the event read, so a fetch can straddle a
 * revocation: the service has the rows in hand but has not sent a frame yet.
 */
let listAfterHold: Promise<void> | undefined;
let onListAfter: (() => void) | undefined;

function fakeStore(): FakeStore {
  return {
    threads: new Map(),
    events: [],
    memberships: new Set([
      `${owner.spaceId}:${owner.userId}`,
      `${member.spaceId}:${member.userId}`,
    ]),
  };
}

function revokeMembership(actor: UserActor): void {
  store.memberships.delete(`${actor.spaceId}:${actor.userId}`);
}

function addThread(id: string, spaceId: string): ThreadRecord {
  const thread: ThreadRecord = {
    id,
    spaceId,
    botId: "01900000-0000-7000-8000-0000000000b0",
    userId: "user-1",
    nextEventSeq: 1,
    nextMessageSeq: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  store.threads.set(id, thread);

  return thread;
}

function appendEvent(threadId: string, seq: number): EventRecord {
  const thread = store.threads.get(threadId);

  if (thread === undefined) {
    throw new Error(`appendEvent: no thread ${threadId}`);
  }

  const record: EventRecord = {
    id: `01900000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    spaceId: thread.spaceId,
    threadId,
    seq,
    type: "run.started",
    payload: {},
    runId: "01900000-0000-7000-8000-0000000000f0",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  store.events.push(record);

  return record;
}

/** Persist, then publish, the way a writer must: rows first, signal second. */
async function persist(threadId: string, seq: number): Promise<void> {
  appendEvent(threadId, seq);
  await fanout.publish({ threadId, latestSeq: seq });
}

function fakeRepositories(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the stream suite");
  };

  return {
    actor,
    membership: {
      async requireActive(): Promise<void> {
        if (!store.memberships.has(`${actor.spaceId}:${actor.userId}`)) {
          throw new NotFoundError("space membership", actor.userId);
        }
      },
    },
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
      async findById(id: string): Promise<ThreadRecord> {
        const thread = store.threads.get(id);

        if (thread === undefined || thread.spaceId !== actor.spaceId) {
          throw new NotFoundError("thread", id);
        }

        return thread;
      },
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
    messages: {
      listForThread: notExercised,
      findByNonce: notExercised,
      steer: notExercised,
    },
    toolResults: { read: notExercised },
    events: {
      async listAfter(threadId: string, afterSeq: number, limit: number): Promise<EventRecord[]> {
        onListAfter?.();
        await listAfterHold;

        return store.events
          .filter(
            (event) =>
              event.spaceId === actor.spaceId &&
              event.threadId === threadId &&
              event.seq > afterSeq,
          )
          .sort((left, right) => left.seq - right.seq)
          .slice(0, limit);
      },
    },
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
    notifications: {
      read: notExercised,
      set: notExercised,
    },
    credentials: {
      resolve: notExercised,
      list: notExercised,
      store: notExercised,
      rotate: notExercised,
      remove: notExercised,
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
    modelConnections: {
      findById: notExercised,
      list: notExercised,
      create: notExercised,
      update: notExercised,
      setDefault: notExercised,
      delete: notExercised,
    },
  };
}

/** One fixed key, so the space-mismatch test can mint and replay cursors. */
const cursorSecret = "the-stream-suite-cursor-key";

const server = createApiServer({
  services,
  logger,
  cursorSecret,
  limits: { authenticated: { maxConcurrentStreams: 20 } },
  resolveActor: async () => sessionActor,
  repositoriesFor: (actor) => fakeRepositories(actor),
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

beforeEach(() => {
  lines.length = 0;
  store = fakeStore();
  sessionActor = owner;
  listAfterHold = undefined;
  onListAfter = undefined;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

interface SseFrame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
}

class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(response: Response) {
    if (response.body === null) {
      throw new Error("the subscription response has no body");
    }

    this.#reader = response.body.getReader();
  }

  /** The next data frame, skipping comments (the transport's keep-alives). */
  async next(): Promise<SseFrame> {
    const frame = await this.nextOrEnd();

    if (frame === undefined) {
      throw new Error("the stream ended before the next frame");
    }

    return frame;
  }

  /**
   * The next data frame, or `undefined` when the server ended the stream. The
   * live-revocation and client-disconnect tests need the ending itself to be
   * an observable, not an exception the reader happened to hit.
   */
  async nextOrEnd(): Promise<SseFrame | undefined> {
    for (;;) {
      const boundary = this.#buffer.indexOf("\n\n");

      if (boundary >= 0) {
        const raw = this.#buffer.slice(0, boundary);
        this.#buffer = this.#buffer.slice(boundary + 2);
        const frame = parseFrame(raw);

        if (frame === undefined) {
          continue;
        }

        // oRPC's SSE encoding closes a completed iterator with an explicit
        // `event: done` marker; for the reader that marker *is* the ending.
        if (frame.event === "done") {
          return undefined;
        }

        return frame;
      }

      const { done, value } = await this.#reader.read();

      if (done) {
        return undefined;
      }

      this.#buffer += this.#decoder.decode(value, { stream: true });
    }
  }

  async close(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  let id: string | undefined;
  const data: string[] = [];
  let event: string | undefined;

  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }

  if (id === undefined && event === undefined && data.length === 0) {
    return undefined;
  }

  return { id, event, data: data.join("\n") };
}

interface OpenStreamOptions {
  readonly threadId: string;
  readonly lastEventId?: string | undefined;
  readonly url?: string;
}

interface OpenStream {
  readonly response: Response;
  /** Lazily constructed, so an error response can still be read as JSON. */
  readonly reader: SseReader;
  close(): Promise<void>;
}

async function openStream(options: OpenStreamOptions): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${options.url ?? baseUrl}${rpcPath}/threads/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.lastEventId === undefined ? {} : { "last-event-id": options.lastEventId }),
    },
    body: JSON.stringify({ json: { threadId: options.threadId } }),
    signal: controller.signal,
  });
  let reader: SseReader | undefined;

  return {
    response,

    get reader(): SseReader {
      reader ??= new SseReader(response);

      return reader;
    },

    async close(): Promise<void> {
      controller.abort();
      await reader?.close().catch(() => undefined);
    },
  };
}

/**
 * The frame's event sequence. oRPC's RPC codec wraps every SSE payload in the
 * `{ json: ... }` envelope the typed client unwraps, so the test unwraps it the
 * same way rather than trusting the raw text.
 */
function eventSeq(frame: SseFrame): number {
  expect(frame.event).toBe("message");

  return (JSON.parse(frame.data) as { json: { seq: number } }).json.seq;
}

async function readSeqs(reader: SseReader, count: number): Promise<number[]> {
  const seqs: number[] = [];

  while (seqs.length < count) {
    seqs.push(eventSeq(await reader.next()));
  }

  return seqs;
}

describe("subscribe and resume re-validate the actor and the membership", () => {
  it("answers an anonymous subscribe and an anonymous resume with the typed 401", async () => {
    addThread(spaceOneThread, "space-1");
    sessionActor = null;

    const subscribe = await openStream({ threadId: spaceOneThread });
    expect(subscribe.response.status).toBe(401);
    expect(await subscribe.response.json()).toMatchObject({ json: { code: "UNAUTHORIZED" } });
    await subscribe.close();

    const resume = await openStream({ threadId: spaceOneThread, lastEventId: "any-cursor" });
    expect(resume.response.status).toBe(401);
    await resume.close();
  });

  it("answers a thread outside the actor's space as not-found, never as forbidden", async () => {
    addThread(spaceTwoThread, "space-2");

    const response = await openStream({ threadId: spaceTwoThread });

    expect(response.response.status).toBe(404);
    expect(await response.response.json()).toMatchObject({
      json: { defined: true, code: "NOT_FOUND" },
    });
    await response.close();
  });

  it("refuses a resume after the thread's membership is gone", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);

    const first = await openStream({ threadId: spaceOneThread });
    const firstFrame = await first.reader.next();
    await first.close();

    store.threads.delete(spaceOneThread);

    const resume = await openStream({
      threadId: spaceOneThread,
      lastEventId: firstFrame.id,
    });

    expect(resume.response.status).toBe(404);
    expect(await resume.response.json()).toMatchObject({
      json: { defined: true, code: "NOT_FOUND" },
    });
    await resume.close();
  });

  it("ends an open stream when the actor's membership is revoked mid-stream", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);

    const stream = await openStream({ threadId: spaceOneThread });

    expect(eventSeq(await stream.reader.next())).toBe(1);

    // The membership is revoked while the connection is open and an event is
    // appended after it: the stream must end without delivering that event.
    revokeMembership(owner);
    await persist(spaceOneThread, 2);

    await expect(stream.reader.nextOrEnd()).resolves.toBeUndefined();
    await stream.close();
  });

  it("does not deliver a batch fetched before the membership was revoked", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);
    appendEvent(spaceOneThread, 2);

    let release = (): void => {};
    listAfterHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetching = new Promise<void>((resolve) => {
      onListAfter = resolve;
    });

    const stream = await openStream({ threadId: spaceOneThread });

    // The server has both rows fetched but has not sent a frame. Revoke now,
    // then let the read return: neither frame may be delivered, because the
    // per-frame membership check runs after the fetch.
    await fetching;
    revokeMembership(owner);
    release();

    await expect(stream.reader.nextOrEnd()).resolves.toBeUndefined();
    await stream.close();
  });

  it("refuses a subscribe and a resume once the membership is revoked", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);

    const first = await openStream({ threadId: spaceOneThread });
    const firstFrame = await first.reader.next();
    await first.close();

    revokeMembership(owner);

    for (const attempt of [
      await openStream({ threadId: spaceOneThread }),
      await openStream({ threadId: spaceOneThread, lastEventId: firstFrame.id }),
    ]) {
      expect(attempt.response.status).toBe(404);
      expect(await attempt.response.json()).toMatchObject({
        json: { defined: true, code: "NOT_FOUND" },
      });
      await attempt.close();
    }
  });

  it("refuses a resume by another actor in the same space", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);

    const first = await openStream({ threadId: spaceOneThread });
    const firstFrame = await first.reader.next();
    await first.close();

    sessionActor = member;

    const resume = await openStream({
      threadId: spaceOneThread,
      lastEventId: firstFrame.id,
    });

    expect(resume.response.status).toBe(400);
    expect(await resume.response.json()).toMatchObject({
      json: { defined: true, code: "BAD_REQUEST" },
    });
    await resume.close();
  });
});

describe("a cursor is bound to its actor, space and thread", () => {
  it("refuses a valid cursor replayed on another thread or another space", async () => {
    addThread(spaceOneThread, "space-1");
    addThread(siblingThread, "space-1");
    appendEvent(spaceOneThread, 1);
    appendEvent(siblingThread, 1);

    const stream = await openStream({ threadId: spaceOneThread });
    const cursor = (await stream.reader.next()).id;
    await stream.close();

    if (cursor === undefined) {
      throw new Error("the subscription delivered no cursor");
    }

    const onSibling = await openStream({ threadId: siblingThread, lastEventId: cursor });

    expect(onSibling.response.status).toBe(400);
    expect(await onSibling.response.json()).toMatchObject({
      json: { defined: true, code: "BAD_REQUEST" },
    });
    await onSibling.close();

    // A cursor genuinely signed by this process, but for another space: the
    // thread is visible to the actor, so the refusal is the binding, not the
    // membership check.
    const codec = createCursorCodec(cursorSecret);
    const foreignSpace = codec.sign({
      spaceId: "space-2",
      threadId: spaceOneThread,
      userId: "user-1",
      seq: 1,
    });

    const onForeignSpace = await openStream({
      threadId: spaceOneThread,
      lastEventId: foreignSpace,
    });

    expect(onForeignSpace.response.status).toBe(400);
    expect(await onForeignSpace.response.json()).toMatchObject({
      json: { defined: true, code: "BAD_REQUEST" },
    });
    await onForeignSpace.close();
  });
});

describe("cursor integrity", () => {
  it("refuses a forged cursor: tampered signature, tampered payload and garbage alike", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);

    const stream = await openStream({ threadId: spaceOneThread });
    const cursor = (await stream.reader.next()).id;
    await stream.close();

    if (cursor === undefined) {
      throw new Error("the subscription delivered no cursor");
    }

    const [payload = "", signature = ""] = cursor.split(".");
    const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, s: "space-1", t: spaceOneThread, u: "user-1", q: 999 }),
      "utf8",
    ).toString("base64url");

    for (const candidate of [
      `${payload}.${flipped}`,
      `${forgedPayload}.${signature}`,
      "not-a-cursor",
    ]) {
      const response = await openStream({ threadId: spaceOneThread, lastEventId: candidate });

      expect(response.response.status, candidate).toBe(400);
      expect(await response.response.json()).toMatchObject({
        json: { defined: true, code: "BAD_REQUEST" },
      });
      await response.close();
    }
  });
});

describe("Last-Event-ID", () => {
  it("replays strictly after the cursor the header names", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);
    appendEvent(spaceOneThread, 2);
    appendEvent(spaceOneThread, 3);

    const first = await openStream({ threadId: spaceOneThread });
    const firstFrame = await first.reader.next();
    expect(eventSeq(firstFrame)).toBe(1);
    await first.close();

    const resumed = await openStream({ threadId: spaceOneThread, lastEventId: firstFrame.id });

    expect(resumed.response.status).toBe(200);
    await expect(readSeqs(resumed.reader, 2)).resolves.toEqual([2, 3]);
    await resumed.close();
  });

  it("is honoured through a proxy that only forwards headers and body", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);
    appendEvent(spaceOneThread, 2);

    const first = await openStream({ threadId: spaceOneThread });
    const firstFrame = await first.reader.next();
    await first.close();

    const proxy = forwardingProxy(baseUrl);

    await new Promise<void>((resolve) => {
      proxy.listen(0, "127.0.0.1", resolve);
    });

    const address = proxy.address();

    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }

    const proxyUrl = `http://127.0.0.1:${address.port}`;

    try {
      const resumed = await openStream({
        threadId: spaceOneThread,
        lastEventId: firstFrame.id,
        url: proxyUrl,
      });

      expect(resumed.response.status).toBe(200);
      await expect(readSeqs(resumed.reader, 1)).resolves.toEqual([2]);
      await resumed.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("a dropped connection resumes with no duplicate and no missing event", () => {
  it("delivers each position exactly once across a drop and three live events", async () => {
    addThread(spaceOneThread, "space-1");
    appendEvent(spaceOneThread, 1);
    appendEvent(spaceOneThread, 2);

    const first = await openStream({ threadId: spaceOneThread });
    const beforeDrop = [await first.reader.next(), await first.reader.next()];
    expect(beforeDrop.map(eventSeq)).toEqual([1, 2]);

    const lastCursor = beforeDrop[1]?.id;

    if (lastCursor === undefined) {
      throw new Error("the subscription delivered no cursor");
    }

    await first.close();

    // Events land while the client is away; the rows are the source of truth.
    await persist(spaceOneThread, 3);
    await persist(spaceOneThread, 4);

    const resumed = await openStream({ threadId: spaceOneThread, lastEventId: lastCursor });
    const afterDrop = await readSeqs(resumed.reader, 2);
    expect(afterDrop).toEqual([3, 4]);

    // And a live signal reaches the open stream without a reconnect.
    await persist(spaceOneThread, 5);
    expect(await readSeqs(resumed.reader, 1)).toEqual([5]);

    await resumed.close();

    // Every position exactly once: no duplicate from the replay, no gap from
    // the dropped connection.
    expect([...beforeDrop.map(eventSeq), ...afterDrop, 5]).toEqual([1, 2, 3, 4, 5]);
  });
});

/**
 * A reverse proxy that only preserves what it is given: it forwards the
 * method, the headers and the body untouched, and streams the response back.
 * The resume test drives it to prove `Last-Event-ID` is a header the API reads
 * rather than something a proxy layer would have to re-encode.
 */
function forwardingProxy(upstream: string): Server {
  const proxy = new Hono();

  proxy.all("*", async (context) => {
    const body =
      context.req.method === "GET" || context.req.method === "HEAD"
        ? undefined
        : await context.req.arrayBuffer();

    // Copy the client's headers except the hop-by-hop pair fetch owns; the
    // point of the proxy is that `Last-Event-ID` passes through untouched.
    const headers = new Headers();

    context.req.raw.headers.forEach((value, name) => {
      if (name !== "host" && name !== "content-length") {
        headers.set(name, value);
      }
    });

    const response = await fetch(`${upstream}${context.req.path}`, {
      method: context.req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });

    return new Response(response.body, { status: response.status, headers: response.headers });
  });

  return createServer(getRequestListener(proxy.fetch));
}
