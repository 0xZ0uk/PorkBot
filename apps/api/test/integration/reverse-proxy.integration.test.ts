import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { sessionCookieAttributes, sessionCookieName } from "@porkbot/auth";
import type { EventRecord, ThreadRecord, UserActor, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { hostGatewayAddress, startCaddyProxy } from "@porkbot/testkit";
import type { RunningCaddyProxy } from "@porkbot/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiServer, rpcPath } from "../../src/index.ts";
import type { ApiServices } from "../../src/app.ts";

/**
 * The reverse proxy contract (slice 12.2, PRD decision 32 and story 4): the
 * shipped `deploy/Caddyfile` runs in the pinned Caddy image, in front of the
 * real HTTP app, and a real HTTPS client drives it. The suite exists because
 * the failure it guards is silent — a proxy that buffers turns token streaming
 * into one late block — so it measures inter-frame arrival, resumes a dropped
 * subscription from its signed cursor through the proxy, and asserts the
 * cookie the auth layer mints arrives with its attributes intact.
 *
 * The proxy is the real image and the real config file; the API is the real
 * app over the real session/gate wiring, with the repositories faked at their
 * data seam, the same way the stream suite fakes them. The SPA is a fixture
 * directory mounted where the proxy image bakes the built client, so the
 * deep-link fallback and the asset cache headers — the behaviours a file
 * server can silently get wrong — are measured against the shipped config too.
 */

const service = "@porkbot/api";
const logger = createLogger({ service, write: () => {} });
const fanout = new InProcessRealtimeFanout();

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const threadId = "01900000-0000-7000-8000-000000000001";

const thread: ThreadRecord = {
  id: threadId,
  spaceId: owner.spaceId,
  botId: "01900000-0000-7000-8000-0000000000b0",
  userId: owner.userId,
  nextEventSeq: 1,
  nextMessageSeq: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

let events: EventRecord[] = [];
let sessionActor: UserActor | null = owner;

/** Persist, then publish, the way a writer must: rows first, signal second. */
async function publish(seq: number): Promise<void> {
  events = [
    ...events,
    {
      id: `01900000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
      spaceId: owner.spaceId,
      threadId,
      seq,
      type: "run.started",
      payload: {},
      runId: "01900000-0000-7000-8000-0000000000f0",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ];
  await fanout.publish({ threadId, latestSeq: seq });
}

function notExercised(): never {
  throw new Error("not exercised by the reverse-proxy suite");
}

/**
 * The repository seams the subscription path touches, and nothing else. A seam
 * the code reaches for unexpectedly answers with a thrown error rather than an
 * empty value, so an unhandled path fails here instead of passing quietly.
 */
function streamRepositories(actor: UserActor): UserRepositories {
  const fakes = {
    actor,
    membership: {
      async requireActive(): Promise<void> {
        if (actor.userId !== owner.userId || actor.spaceId !== owner.spaceId) {
          throw new NotFoundError("space membership", actor.userId);
        }
      },
    },
    threads: {
      async findById(id: string): Promise<ThreadRecord> {
        if (id !== threadId) {
          throw new NotFoundError("thread", id);
        }

        return thread;
      },
    },
    events: {
      async listAfter(id: string, afterSeq: number, limit: number): Promise<EventRecord[]> {
        return events
          .filter((event) => event.threadId === id && event.spaceId === actor.spaceId)
          .filter((event) => event.seq > afterSeq)
          .sort((left, right) => left.seq - right.seq)
          .slice(0, limit);
      },
    },
  };

  const refusing = new Proxy(function refusingStub(): void {} as unknown as object, {
    get: () => notExercised,
  });

  return new Proxy(fakes as unknown as UserRepositories, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver) as unknown;

      return value === undefined ? refusing : value;
    },
  });
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
  realtime: fanout,
};

/**
 * A session cookie carrying the shipped attributes. Better Auth mints the real
 * one and the auth integration suite asserts its attributes; this suite's
 * subject is the proxy, so a stub answers with the same values and the test
 * asserts the hop preserves them exactly and adds no cross-origin grant.
 */
function sessionCookie(): string {
  const attributes = sessionCookieAttributes;
  const sameSite = `${attributes.sameSite ?? ""}`;

  return [
    `${sessionCookieName}=opaque-session-value`,
    `Path=${attributes.path}`,
    ...(attributes.httpOnly ? ["HttpOnly"] : []),
    `SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`,
    // The deployment's origin is https, which is what makes the auth layer
    // mark the cookie Secure (see `createOperatorAuth`).
    "Secure",
  ].join("; ");
}

const apiServer: Server = createApiServer({
  services,
  logger,
  cursorSecret: "the-reverse-proxy-suite-cursor-key",
  // One stream at a time per actor, so a slot the proxy failed to release on
  // disconnect is a visible failure rather than a hidden leak.
  limits: { authenticated: { maxConcurrentStreams: 1 } },
  resolveActor: async () => sessionActor,
  repositoriesFor: (actor) => streamRepositories(actor),
  authHandler: async () =>
    new Response(JSON.stringify({ session: null }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": sessionCookie(),
      },
    }),
});

let webRoot = "";

let proxy: RunningCaddyProxy | undefined;

function caddy(): RunningCaddyProxy {
  if (proxy === undefined) {
    throw new Error("the proxy was not started; the beforeAll hook failed first");
  }

  return proxy;
}

async function listenOnBridge(server: Server, port: number): Promise<number> {
  const gateway = await hostGatewayAddress();

  await new Promise<void>((resolve) => {
    server.listen(port, gateway, resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  return address.port;
}

beforeAll(async () => {
  // The artifact's shape: one shell and hashed assets under /assets, with no
  // index.html and no server routes — exactly what `apps/web`'s build emits.
  webRoot = await mkdtemp(path.join(tmpdir(), "porkbot-proxy-spa-"));
  await mkdir(path.join(webRoot, "assets"));
  await writeFile(path.join(webRoot, "_shell.html"), "<!doctype html><title>porkbot</title>");
  await writeFile(path.join(webRoot, "assets", "index-abc123.js"), "export {};\n");

  const apiPort = await listenOnBridge(apiServer, 0);

  proxy = await startCaddyProxy({
    siteAddress: "https://localhost",
    apiUpstream: `http://host.docker.internal:${String(apiPort)}`,
    webRoot,
  });
}, 120_000);

beforeEach(() => {
  events = [];
  sessionActor = owner;
});

afterAll(async () => {
  await proxy?.stop();

  await new Promise<void>((resolve, reject) => {
    apiServer.closeAllConnections();
    apiServer.close((error) => (error ? reject(error) : resolve()));
  });

  await rm(webRoot, { recursive: true, force: true });
});

interface ProxyResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface RequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

function requestInit(options: RequestOptions): {
  readonly host: string;
  readonly port: string;
  readonly method: string;
  readonly headers: Record<string, string> | undefined;
  readonly ca: string | undefined;
} {
  return {
    host: "localhost",
    port: new URL(caddy().siteUrl).port,
    method: options.method ?? "GET",
    headers: options.headers,
    ca: caddy().rootCertificate,
  };
}

/** A whole response, read to the end. For diagnostics and JSON endpoints. */
async function requestThroughProxy(
  pathname: string,
  options: RequestOptions = {},
): Promise<ProxyResponse> {
  const url = new URL(pathname, caddy().siteUrl);

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { ...requestInit(options), path: `${url.pathname}${url.search}` },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );

    request.on("error", reject);

    if (options.body !== undefined) {
      request.write(options.body);
    }

    request.end();
  });
}

interface SseFrame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
}

function parseFrame(raw: string): SseFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];

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

async function* frames(response: IncomingMessage): AsyncGenerator<SseFrame> {
  let buffer = "";

  for await (const chunk of response) {
    buffer += (chunk as Buffer).toString("utf8");

    for (;;) {
      const boundary = buffer.indexOf("\n\n");

      if (boundary < 0) {
        break;
      }

      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const frame = parseFrame(raw);

      if (frame !== undefined && frame.event !== "done") {
        yield frame;
      }
    }
  }
}

interface StreamFrame {
  readonly frame: SseFrame;
  readonly receivedAt: number;
}

interface OpenStream {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** The next frame, or a failure when none arrives inside the budget. */
  next(timeoutMs?: number): Promise<StreamFrame>;
  close(): void;
}

/**
 * Opens a stream through the proxy. The timeout is what makes buffering fail
 * as a clear message instead of a hanging test: a proxy that holds the whole
 * response never delivers the first frame.
 */
async function openStream(pathname: string, options: RequestOptions = {}): Promise<OpenStream> {
  const url = new URL(pathname, caddy().siteUrl);
  const request = httpsRequest({ ...requestInit(options), path: `${url.pathname}${url.search}` });
  request.end(options.body);

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  const iterator = frames(response);

  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    async next(timeoutMs = 5_000): Promise<StreamFrame> {
      const timeout = delay(timeoutMs).then(() => {
        throw new Error(`no stream frame arrived through the proxy within ${timeoutMs} ms`);
      });
      const result = await Promise.race([iterator.next(), timeout]);

      if (result.done === true) {
        throw new Error("the stream ended before the next frame");
      }

      return { frame: result.value, receivedAt: Date.now() };
    },
    close(): void {
      request.destroy();
      response.destroy();
      void iterator.return(undefined).catch(() => {});
    },
  };
}

function rpcSubscription(options: { readonly lastEventId?: string } = {}): RequestOptions {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.lastEventId === undefined ? {} : { "last-event-id": options.lastEventId }),
    },
    body: JSON.stringify({ json: { threadId } }),
  };
}

function eventSeq(frame: SseFrame): number {
  expect(frame.event).toBe("message");

  return (JSON.parse(frame.data) as { json: { seq: number } }).json.seq;
}

describe("the reverse proxy at production settings", () => {
  it("routes the SPA, the API and the probe through the shipped config", async () => {
    const spa = await requestThroughProxy("/");

    expect(spa.status).toBe(200);
    expect(spa.headers["content-type"]).toContain("text/html");
    expect(spa.body).toContain("porkbot");

    const health = await requestThroughProxy("/healthz");
    const body = JSON.parse(health.body) as { status: string; service: string };

    expect(health.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe(service);
  });

  it("serves a deep-linked client route with the shell, and a missing asset as 404", async () => {
    // The SPA rewrite, two halves of one rule: an extension-less path is a
    // client route and gets the shell so the router can resolve it, while a
    // missing file with an extension stays a 404 — answering the shell there
    // would turn a broken bundle reference into a blank page with a 200.
    for (const route of ["/sign-in", "/settings/models"]) {
      const response = await requestThroughProxy(route);

      expect(response.status, route).toBe(200);
      expect(response.headers["content-type"], route).toContain("text/html");
      expect(response.body, route).toContain("porkbot");
    }

    const missing = await requestThroughProxy("/assets/does-not-exist.js");

    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain("<!doctype html>");
  });

  it("caches a hashed asset forever and the document never", async () => {
    // Two policies, and the difference is the point: the document is the
    // release and must never be pinned by a cache, while a hashed asset is
    // content-addressed and safe to keep for a year.
    const asset = await requestThroughProxy("/assets/index-abc123.js");

    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    for (const route of ["/", "/sign-in"]) {
      const document = await requestThroughProxy(route);

      expect(document.status, route).toBe(200);
      expect(document.headers["cache-control"], route).toBe("no-cache");
    }
  });

  it("routes every API mount to the API, not the SPA's file server", async () => {
    // The webhook path matters most: providers call it directly, so it is not
    // one of the mounts the web dev server forwards, and a missing matcher
    // would have handed it to the SPA, where a provider would read
    // the shell as a 200. The upload and download paths are here so the
    // Caddy path patterns for them are exercised, not just asserted textually.
    const cases: readonly { readonly path: string; readonly method?: string }[] = [
      { path: "/webhooks/probe-source", method: "POST" },
      { path: "/livez" },
      { path: "/readyz" },
      { path: "/files/01900000-0000-7000-8000-0000000000f1" },
      { path: `/threads/${threadId}/attachments?filename=notes.txt`, method: "POST" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const response = await requestThroughProxy(testCase.path, {
        method: testCase.method ?? "GET",
      });

      expect(response.headers["content-type"], testCase.path).toContain("application/json");
      expect(response.body, testCase.path).not.toContain("<!doctype html>");

      if (index === 0) {
        // The default ingress refuses an unknown source with a typed refusal,
        // so the webhook case proves the request reached the API's own route.
        expect(response.status).toBe(401);
      }
    }
  });

  it("delivers the probe's frames apart, not in one buffered block", async () => {
    const probe = await openStream("/healthz/stream");

    expect(probe.status).toBe(200);
    expect(probe.headers["content-type"]).toBe("text/event-stream");

    const first = await probe.next();
    const second = await probe.next();
    const third = await probe.next();

    probe.close();

    expect([first.frame.id, second.frame.id, third.frame.id]).toEqual(["1", "2", "3"]);
    // The shipped probe spaces frames 250 ms apart, so the first and last are
    // 500 ms apart when the proxy streams them. One that buffers delivers all
    // three together and this gap collapses; the threshold leaves room for a
    // loaded runner without accepting a collapse.
    expect(third.receivedAt - first.receivedAt).toBeGreaterThanOrEqual(100);
  });

  it("delivers a subscription's events as they are produced", async () => {
    const stream = await openStream(`${rpcPath}/threads/events`, rpcSubscription());

    expect(stream.status).toBe(200);

    await publish(1);

    const first = await stream.next();

    await delay(300);
    await publish(2);

    const second = await stream.next();

    stream.close();

    expect(eventSeq(first.frame)).toBe(1);
    expect(eventSeq(second.frame)).toBe(2);
    expect(second.receivedAt - first.receivedAt).toBeGreaterThanOrEqual(200);
  });

  it("resumes a dropped subscription from its signed cursor", async () => {
    const stream = await openStream(`${rpcPath}/threads/events`, rpcSubscription());

    await publish(1);

    const first = await stream.next();
    const cursor = first.frame.id;

    expect(eventSeq(first.frame)).toBe(1);
    expect(cursor).toBeDefined();

    stream.close();

    // The event lands while nobody is subscribed, so only a replay from the
    // cursor can deliver it: a proxy that dropped Last-Event-ID would start
    // over at seq 1, and one that buffered would not deliver it at all.
    await publish(2);
    await delay(100);

    const resumed = await openStream(
      `${rpcPath}/threads/events`,
      rpcSubscription({ lastEventId: cursor ?? "" }),
    );

    const replayed = await resumed.next();

    resumed.close();

    expect(eventSeq(replayed.frame)).toBe(2);
    expect(replayed.frame.id).not.toBe(cursor);
  });

  it("refuses a cursor that was not issued for this stream", async () => {
    const response = await requestThroughProxy(
      `${rpcPath}/threads/events`,
      rpcSubscription({ lastEventId: "not-a-cursor" }),
    );

    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("passes the session cookie through with the shipped attributes and adds no CORS", async () => {
    const response = await requestThroughProxy("/api/auth/session");

    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toEqual([sessionCookie()]);

    const cookie = response.headers["set-cookie"]?.[0] ?? "";

    expect(cookie).toContain(`${sessionCookieName}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    // One origin, so the proxy must not invent a cross-origin grant.
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("releases an actor's stream slot when the client disconnects", async () => {
    const held = await openStream(`${rpcPath}/threads/events`, rpcSubscription());

    expect(held.status).toBe(200);

    // The cap is one per actor in this suite, so a second stream is refused
    // while the first is held — which is what makes the release observable.
    const refused = await openStream(`${rpcPath}/threads/events`, rpcSubscription());

    expect(refused.status).toBe(429);

    refused.close();
    held.close();

    // The proxy must let the API see the disconnect; otherwise the slot stays
    // held and every reconnect is refused.
    const deadline = Date.now() + 5_000;
    let admitted: OpenStream | undefined;

    while (Date.now() < deadline) {
      const candidate = await openStream(`${rpcPath}/threads/events`, rpcSubscription());

      if (candidate.status === 200) {
        admitted = candidate;
        break;
      }

      candidate.close();
      await delay(100);
    }

    expect(admitted, "the stream slot was never released").toBeDefined();
    admitted?.close();
  });
});
