import { Hono } from "hono";
import { ORPCError } from "@orpc/server";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { appContract, createApiClient } from "@porkbot/contracts";
import type { UserActor, UserRepositories } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp, rpcPath, serviceName } from "./app.ts";
import type { ApiAppOptions, ApiServices } from "./app.ts";
import {
  actorPrincipal,
  installLimits,
  resolveLimits,
  routeRuleFor,
  routeRules,
} from "./limits.ts";
import type { LimitEnv, LimitsOverrides } from "./limits.ts";
import { createApiServer } from "./server.ts";
import type { DeploymentStatus } from "./services/deployment.ts";

/**
 * Limits over the real HTTP surface. Each describe proves one acceptance
 * criterion: every contract procedure is limited (so a new one cannot be
 * silently unlimited), the refusal is a typed 429 with `Retry-After`, an
 * oversized body is rejected before it is parsed, and one actor cannot hold
 * more stream slots than its cap.
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

/**
 * The caps the surface tests start from: small enough to exhaust on purpose
 * and large enough that the unrelated calls each test makes fit.
 */
const testLimits: LimitsOverrides = {
  authenticated: { requestsPerMinute: 120, maxConcurrentStreams: 2, maxBodyBytes: 1_024 },
  anonymous: { requestsPerMinute: 120, maxConcurrentStreams: 2, maxBodyBytes: 512 },
  webhook: { requestsPerMinute: 120, maxBodyBytes: 512 },
  probe: { requestsPerMinute: 120 },
};

function testApp(
  limits: LimitsOverrides = {},
  extra: Partial<ApiAppOptions> = {},
): ReturnType<typeof createApiApp> {
  return createApiApp({
    services,
    logger,
    limits: { ...testLimits, ...limits },
    clientKey: (context) => context.req.header("x-test-client") ?? "test-client",
    ...extra,
  });
}

interface ContractLeaf {
  readonly name: string;
  readonly segments: readonly string[];
}

/**
 * Walks the contract tree the way `access.test.ts` does, without oRPC
 * imports. The RPC handler matches on the tree path (`/bots/get`), not the
 * OpenAPI route path (`/bots/{id}`), so the segments are what a request needs.
 */
function contractLeaves(node: unknown, prefix: readonly string[] = []): ContractLeaf[] {
  if (typeof node !== "object" || node === null) {
    return [];
  }

  const record = node as Record<string, unknown>;

  if (typeof record["~orpc"] === "object" && record["~orpc"] !== null) {
    return [{ name: prefix.join("."), segments: prefix }];
  }

  return Object.entries(record).flatMap(([key, value]) => contractLeaves(value, [...prefix, key]));
}

const requestBodies: Record<string, string> = {
  "bots.get": JSON.stringify({ json: { id: "bot-1" } }),
  "threads.events": JSON.stringify({ json: { threadId: "thread-1" } }),
};

describe("the route list", () => {
  it("maps every installed HTTP route to a rule and keeps the inventory exact", () => {
    const app = testApp();
    const rules = routeRules(rpcPath);
    const routes = app.routes.filter((route) => route.method !== "ALL");

    // A new non-RPC route changes this list and must be argued for in the
    // register at the same time; the RPC surface is one rule and is covered
    // by the contract walk below. The webhook ingress is the public one, and
    // it is registered as the `webhook` family rather than the anonymous
    // fallback.
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /healthz",
      "POST /webhooks/:source",
    ]);

    for (const route of routes) {
      expect(
        routeRuleFor(rules, route.method, route.path),
        `${route.method} ${route.path} has no limit rule`,
      ).toBeDefined();
    }

    expect(routeRuleFor(rules, "POST", "/webhooks/:source")?.family).toBe("webhook");
  });
});

describe("every contract procedure", () => {
  it("is limited, so a new procedure cannot be silently unlimited", async () => {
    const leaves = contractLeaves(appContract as unknown as Record<string, unknown>);

    expect(leaves.map((leaf) => leaf.name).sort()).toEqual([
      "account.me",
      "bots.get",
      "deployment.status",
      "threads.events",
    ]);

    for (const leaf of leaves) {
      const app = testApp({
        anonymous: { requestsPerMinute: 1, maxConcurrentStreams: 1, maxBodyBytes: 512 },
      });
      const url = `${rpcPath}/${leaf.segments.join("/")}`;
      const headers = {
        "content-type": "application/json",
        "x-test-client": leaf.name.replace(".", "-"),
      };
      const body = requestBodies[leaf.name] ?? "{}";

      const first = await app.request(url, { method: "POST", headers, body });
      const second = await app.request(url, { method: "POST", headers, body });

      expect(first.status, `${leaf.name} first call must not be limited`).not.toBe(429);
      expect(second.status, `${leaf.name} second call must be limited`).toBe(429);
      expect(second.headers.get("retry-after")).toBe("60");

      // The RPC wire format wraps the serialized value in `json`; the error
      // JSON inside it is the contract's shape.
      expect(await second.json()).toMatchObject({
        json: {
          defined: true,
          code: "RATE_LIMITED",
          status: 429,
          data: { retryAfterSeconds: 60 },
        },
      });
    }
  });
});

describe("the typed answer", () => {
  const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };

  function stubRepositories(actor: UserActor): UserRepositories {
    const notExercised = async (): Promise<never> => {
      throw new Error("not exercised by the limits suite");
    };

    return {
      actor,
      bots: {
        findById: notExercised,
        list: notExercised,
        create: notExercised,
        update: notExercised,
      },
      threads: { findById: notExercised, listForBot: notExercised, createForBot: notExercised },
      runs: { findById: notExercised, listForThread: notExercised, create: notExercised },
      events: { listAfter: notExercised },
    };
  }

  const server = createApiServer({
    services,
    logger,
    limits: {
      ...testLimits,
      authenticated: { requestsPerMinute: 1, maxConcurrentStreams: 1, maxBodyBytes: 1_024 },
    },
    resolveActor: async () => owner,
    repositoriesFor: (actor) => stubRepositories(actor),
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

  it("refuses the next authenticated call with the typed error, Retry-After and typed client", async () => {
    const client = createApiClient({ url: `${baseUrl}/rpc` });

    await expect(client.account.me()).resolves.toMatchObject({ userId: "user-1" });

    const raw = await fetch(`${baseUrl}/rpc/account/me`, { method: "POST" });

    expect(raw.status).toBe(429);
    expect(raw.headers.get("retry-after")).toBe("60");
    expect(await raw.json()).toMatchObject({
      json: {
        defined: true,
        code: "RATE_LIMITED",
        status: 429,
        data: { retryAfterSeconds: 60 },
      },
    });

    const error = await client.account.me().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", status: 429, defined: true });

    if (error instanceof ORPCError) {
      expect(error.data).toMatchObject({ retryAfterSeconds: 60 });
    }
  });
});

describe("body caps", () => {
  it("rejects an oversized RPC body before it is parsed", async () => {
    const app = testApp();

    const response = await app.request(`${rpcPath}/deployment/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-client": "body-cap" },
      // Not JSON on purpose: if the cap did not fire first, the parser would
      // answer with a validation error instead of a 413.
      body: "x".repeat(2_048),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large", maxBytes: 1_024 });
  });

  it("rejects a chunked body that grows past the cap while it is read", async () => {
    const app = testApp();
    const chunk = new TextEncoder().encode("x".repeat(2_048));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request(`http://localhost${rpcPath}/deployment/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-client": "chunked-cap" },
      body,
      duplex: "half",
    } as RequestInit);

    const response = await app.request(request);

    expect(response.status).toBe(413);
  });

  it("lets a body under the cap reach the procedure", async () => {
    const app = testApp();
    const response = await app.request(`${rpcPath}/deployment/status`, {
      method: "POST",
      headers: { "x-test-client": "small-body" },
    });

    expect(response.status).toBe(200);
  });
});

describe("stream connection caps", () => {
  const limits: LimitsOverrides = {
    authenticated: { requestsPerMinute: 120, maxConcurrentStreams: 2, maxBodyBytes: 1_024 },
    anonymous: { requestsPerMinute: 120, maxConcurrentStreams: 2, maxBodyBytes: 512 },
  };

  /**
   * A stand-in for the SSE surface a later slice adds: it returns the
   * `text/event-stream` content type the connection guard keys on and keeps
   * the body open until the test cancels it. It sets the same `principal`
   * variable the RPC handler sets after the gate resolves an actor, so the
   * cap is proven per actor, not per connection.
   */
  function streamApp(): ReturnType<typeof createApiApp> {
    const app = testApp(limits);

    app.get("/test/stream", (context) => {
      const actorId = context.req.query("actor");

      if (actorId !== undefined) {
        context.set(
          "principal",
          actorPrincipal({ kind: "user", spaceId: "space-1", userId: actorId, role: "owner" }),
        );
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: open\n\n"));
        },
      });

      return context.newResponse(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    return app;
  }

  it("refuses one actor past the cap without touching another actor's slots", async () => {
    const app = streamApp();

    const first = await app.request("/test/stream?actor=a");
    const second = await app.request("/test/stream?actor=a");
    const third = await app.request("/test/stream?actor=a");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("1");
    expect(await third.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 1 });

    const otherActor = await app.request("/test/stream?actor=b");
    expect(otherActor.status).toBe(200);

    await first.body?.cancel();

    const afterRelease = await app.request("/test/stream?actor=a");
    expect(afterRelease.status).toBe(200);
  });

  it("answers a stream refusal on the RPC path with the contract's error envelope", async () => {
    const app = testApp({
      anonymous: { requestsPerMinute: 120, maxConcurrentStreams: 1, maxBodyBytes: 512 },
    });

    app.get("/rpc/test/stream", (context) =>
      context.newResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: open\n\n"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const first = await app.request("/rpc/test/stream");

    expect(first.status).toBe(200);

    const second = await app.request("/rpc/test/stream");

    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(await second.json()).toMatchObject({
      defined: true,
      code: "RATE_LIMITED",
      status: 429,
      data: { retryAfterSeconds: 1 },
    });

    await first.body?.cancel();
  });

  it("limits how often a stream can be opened", async () => {
    const app = testApp({
      anonymous: { requestsPerMinute: 2, maxConcurrentStreams: 2, maxBodyBytes: 512 },
    });

    app.get("/test/stream", (context) =>
      context.newResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: open\n\n"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const first = await app.request("/test/stream");
    const second = await app.request("/test/stream");

    await first.body?.cancel();
    await second.body?.cancel();

    const third = await app.request("/test/stream");

    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });
});

describe("the webhook family", () => {
  /**
   * The webhook ingress route itself lands with slice 4.5; this proves the
   * family's budget and body cap are executable now, so mounting the route is
   * adding a rule and a handler, not discovering the limiter needs a branch.
   */
  function webhookApp(webhook: { requestsPerMinute: number; maxBodyBytes: number }) {
    const app = new Hono<LimitEnv>();
    installLimits(app, {
      config: resolveLimits({ webhook }),
      rules: [{ method: "POST", path: "/webhooks/*", family: "webhook" }],
      clientKey: () => "webhook-client",
    });
    app.post("/webhooks/test", (context) => context.text("received"));
    return app;
  }

  it("spends the webhook budget per client", async () => {
    const app = webhookApp({ requestsPerMinute: 1, maxBodyBytes: 512 });

    expect((await app.request("/webhooks/test", { method: "POST" })).status).toBe(200);
    expect((await app.request("/webhooks/test", { method: "POST" })).status).toBe(429);
  });

  it("caps the webhook body at the family's cap", async () => {
    const app = webhookApp({ requestsPerMinute: 10, maxBodyBytes: 16 });

    const response = await app.request("/webhooks/test", {
      method: "POST",
      body: JSON.stringify({ payload: "far more than sixteen bytes" }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large", maxBytes: 16 });
  });
});

describe("the budgets are separate", () => {
  it("keeps the probe budget out of the anonymous budget", async () => {
    const app = testApp({
      probe: { requestsPerMinute: 1 },
      anonymous: { requestsPerMinute: 5, maxConcurrentStreams: 1, maxBodyBytes: 512 },
    });

    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(429);
    expect((await app.request("/unknown")).status).toBe(404);
  });

  it("limits a path the register does not know instead of leaving it open", async () => {
    const app = testApp({
      anonymous: { requestsPerMinute: 1, maxConcurrentStreams: 1, maxBodyBytes: 512 },
    });

    expect((await app.request("/unknown")).status).toBe(404);
    expect((await app.request("/unknown")).status).toBe(429);
  });
});
