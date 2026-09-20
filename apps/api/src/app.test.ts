import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ORPCError } from "@orpc/server";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient } from "@porkbot/contracts";
import type { AppClient } from "@porkbot/contracts";
import { createLogger, redactedPlaceholder } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { authBasePath, createApiApp, serviceName } from "./app.ts";
import type { ApiServices } from "./app.ts";
import { createApiServer } from "./server.ts";
import type { DeploymentStatus } from "./services/deployment.ts";

const lines: string[] = [];
const logger: Logger = createLogger({
  service: serviceName,
  write: (line) => lines.push(line),
});

let result: unknown = { kind: "open" };
let failure: Error | undefined;
const services: ApiServices = {
  deployment: {
    async status(): Promise<DeploymentStatus> {
      if (failure !== undefined) {
        throw failure;
      }

      return result as DeploymentStatus;
    },
    async ownership() {
      return { kind: "configured", ownerEmail: null } as const;
    },
  },
  realtime: new InProcessRealtimeFanout(),
};

const app = createApiApp({ services, logger, generateRequestId: () => "generated-request-id" });
const server = createApiServer({
  services,
  logger,
  generateRequestId: () => "generated-request-id",
});
let client: AppClient;
let baseUrl = "";

function records(): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

async function waitForRecord(
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    const match = records().find(predicate);

    if (match !== undefined) {
      return match;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("no matching log line was written");
}

function requestRecordFor(requestId: string): Promise<Record<string, unknown>> {
  return waitForRecord(
    (candidate) => candidate["msg"] === "request" && candidate["requestId"] === requestId,
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
  client = createApiClient({ url: `${baseUrl}/rpc` });
});

beforeEach(() => {
  lines.length = 0;
  result = { kind: "open" };
  failure = undefined;
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

describe("the http surface", () => {
  it("answers /healthz with the service identity", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    const body = (await response.json()) as { status: string; service: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe(serviceName);
  });

  it("keeps liveness separate from dependency readiness", async () => {
    let dependencyUp = false;
    const dependencyApp = createApiApp({
      services,
      logger,
      readiness: () => dependencyUp,
    });

    expect((await dependencyApp.request("/livez")).status).toBe(200);

    const notReady = await dependencyApp.request("/readyz");
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ status: "not_ready", service: serviceName });

    dependencyUp = true;
    const ready = await dependencyApp.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready", service: serviceName });
  });

  it("answers unknown routes with 404", async () => {
    const response = await fetch(`${baseUrl}/unknown`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("leaves an unmatched /rpc path to the router", async () => {
    const response = await fetch(`${baseUrl}/rpc/unknown`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("echoes a client correlation id and logs a redacted request line", async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { "x-request-id": "req-42" },
    });

    expect(response.headers.get("x-request-id")).toBe("req-42");

    const record = await requestRecordFor("req-42");

    expect(record).toMatchObject({
      level: "info",
      msg: "request",
      method: "GET",
      path: "/healthz",
      status: 200,
      correlationId: "req-42",
      service: serviceName,
    });
    expect(typeof record["timestamp"]).toBe("string");
    expect(typeof record["durationMs"]).toBe("number");
  });

  it("generates a correlation id when the client sends none", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    const requestId = response.headers.get("x-request-id");

    expect(requestId).toBe("generated-request-id");
    expect((await requestRecordFor(requestId ?? ""))["correlationId"]).toBe(requestId);
  });

  it("takes the first non-blank id from a repeated header", async () => {
    const response = await app.request(`${baseUrl}/healthz`, {
      headers: { "x-request-id": "  , req-2  " },
    });

    expect(response.headers.get("x-request-id")).toBe("req-2");
  });

  it("levels 404s as warnings and redacts credentials in the query string", async () => {
    const response = await fetch(`${baseUrl}/oauth/callback?access_token=abc123&state=xyz`);

    expect(response.status).toBe(404);

    const record = await waitForRecord(
      (candidate) =>
        candidate["path"] === `/oauth/callback?access_token=${redactedPlaceholder}&state=xyz`,
    );

    expect(record).toMatchObject({
      level: "warn",
      msg: "request",
      status: 404,
      path: `/oauth/callback?access_token=${redactedPlaceholder}&state=xyz`,
    });
    expect(lines.join("")).not.toContain("abc123");
  });

  it("answers a thrown defect with 500 and logs both lines redacted", async () => {
    // A route on a fresh app, added after the boundary middleware like every
    // real route: the defect must still be caught and both lines written.
    const explodingApp = createApiApp({ services, logger });
    explodingApp.get("/test/explode", () => {
      throw new Error("route exploded with token=abc123");
    });

    const response = await explodingApp.request("/test/explode", {
      headers: { "x-request-id": "req-boom" },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(lines.join("")).not.toContain("abc123");

    const failure = await waitForRecord(
      (candidate) => candidate["msg"] === "request failed" && candidate["requestId"] === "req-boom",
    );

    expect(failure).toMatchObject({
      level: "error",
      error: { name: "Error", message: `route exploded with token=${redactedPlaceholder}` },
      path: "/test/explode",
    });
    expect(await requestRecordFor("req-boom")).toMatchObject({ level: "error", status: 500 });
  });
});

describe("the operator auth mount", () => {
  it("serves every method under /api/auth/* through the injected handler", async () => {
    const paths: string[] = [];
    const app = createApiApp({
      services,
      logger,
      authHandler: async (request) => {
        const url = new URL(request.url);
        paths.push(`${request.method} ${url.pathname}`);

        return new Response("handled", { status: 200 });
      },
    });

    const signIn = await app.request(`${authBasePath}/sign-in/email`, { method: "POST" });
    const session = await app.request(`${authBasePath}/get-session`);

    expect(signIn.status).toBe(200);
    expect(session.status).toBe(200);
    expect(paths).toEqual([
      `POST ${authBasePath}/sign-in/email`,
      `GET ${authBasePath}/get-session`,
    ]);
  });

  it("leaves the prefix unmounted when no handler is configured", async () => {
    const app = createApiApp({ services, logger });
    const response = await app.request(`${authBasePath}/sign-in/email`, { method: "POST" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("the rpc surface", () => {
  it("answers a contract procedure with its output type", async () => {
    result = { kind: "open" };
    const body = await client.deployment.status();

    expect(body).toEqual({ signups: "open" });

    const record = await requestRecordFor("generated-request-id");
    expect(record).toMatchObject({ method: "POST", path: "/rpc/deployment/status", status: 200 });
  });

  it("reports a closed deployment as closed", async () => {
    result = { kind: "closed" };

    expect(await client.deployment.status()).toEqual({ signups: "closed" });
  });

  it("throws the procedure's declared error when the deployment is misconfigured", async () => {
    result = { kind: "misconfigured" };

    const response = await fetch(`${baseUrl}/rpc/deployment/status`, { method: "POST" });

    expect(response.status).toBe(503);

    const error = await client.deployment.status().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
      defined: true,
    });

    const record = await requestRecordFor("generated-request-id");
    expect(record).toMatchObject({ level: "error", status: 503 });
  });

  it("maps an unexpected service failure to 500 and logs it redacted", async () => {
    failure = new Error("service exploded with token=abc123");

    const error = await client.deployment.status().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500, defined: false });
    const envelope = JSON.stringify(error);
    expect(envelope).not.toContain("abc123");
    expect(envelope).not.toContain("service exploded");
    expect(lines.join("")).not.toContain("abc123");

    const record = await waitForRecord((candidate) => candidate["msg"] === "request failed");

    expect(record).toMatchObject({
      level: "error",
      error: { name: "Error", message: `service exploded with token=${redactedPlaceholder}` },
      path: "/rpc/deployment/status",
    });
  });

  it("rejects an output that violates the contract schema", async () => {
    result = { kind: "nonsense" };

    const error = await client.deployment.status().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500 });
  });
});
