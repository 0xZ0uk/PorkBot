import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger, redactedPlaceholder } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { createApiServer, createRequestListener, serviceName } from "./server.ts";

const lines: string[] = [];
const logger: Logger = createLogger({
  service: serviceName,
  write: (line) => lines.push(line),
});

const server = createApiServer({ logger });
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

function fakeResponse(): {
  response: ServerResponse;
  headers: Record<string, string>;
  result: () => { status: number; body: string };
} {
  const headers: Record<string, string> = {};
  const finishes: (() => void)[] = [];
  let status = 0;
  let body = "";
  const response = {
    headersSent: false,
    statusCode: 0,
    setHeader(name: string, value: string): void {
      headers[name] = value;
    },
    writeHead(code: number): void {
      status = code;
      response.statusCode = code;
    },
    end(chunk?: string): void {
      body = chunk ?? "";
      for (const finish of finishes) {
        finish();
      }
    },
    on(event: string, listener: () => void): void {
      if (event === "finish") {
        finishes.push(listener);
      }
    },
  } as unknown as ServerResponse;

  return { response, headers, result: () => ({ status, body }) };
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
});

beforeEach(() => {
  lines.length = 0;
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

describe("api", () => {
  it("answers /healthz with the service identity", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    const body = (await response.json()) as { status: string; service: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe(serviceName);
  });

  it("answers unknown routes with 404", async () => {
    const response = await fetch(`${baseUrl}/unknown`);
    expect(response.status).toBe(404);
  });

  it("logs a correlated, redacted request line for every response", async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { "x-request-id": "req-42" },
    });
    expect(response.headers.get("x-request-id")).toBe("req-42");

    const record = await waitForRecord(
      (candidate) => candidate["msg"] === "request" && candidate["requestId"] === "req-42",
    );

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

    expect(requestId).toEqual(expect.any(String));
    expect(requestId?.length).toBeGreaterThan(0);

    const record = await waitForRecord(
      (candidate) => candidate["msg"] === "request" && candidate["requestId"] === requestId,
    );
    expect(record["correlationId"]).toBe(requestId);
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
});

describe("api error boundary", () => {
  it("answers 500 and logs the error and the finished response redacted", () => {
    const errorLines: string[] = [];
    const errorLogger = createLogger({
      service: serviceName,
      write: (line) => errorLines.push(line),
    });
    const { response, result } = fakeResponse();

    const failure = new Error("handler exploded with token=abc123");
    const request = {
      method: "GET",
      url: "/callback?password",
      headers: Object.defineProperty({}, "x-request-id", {
        get(): never {
          throw failure;
        },
      }),
    } as unknown as IncomingMessage;

    createRequestListener({ logger: errorLogger })(request, response);

    expect(result().status).toBe(500);
    expect(JSON.parse(result().body)).toEqual({ error: "internal_error" });
    expect(errorLines.join("")).not.toContain("abc123");

    const records = errorLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.find((record) => record["msg"] === "request failed")).toMatchObject({
      level: "error",
      error: { name: "Error", message: `handler exploded with token=${redactedPlaceholder}` },
      path: "/callback?[redacted]",
    });
    expect(records.find((record) => record["msg"] === "request")).toMatchObject({
      level: "error",
      status: 500,
      path: "/callback?[redacted]",
    });
  });

  it("takes the first non-blank x-request-id when the header repeats", () => {
    const headerLines: string[] = [];
    const headerLogger = createLogger({
      service: serviceName,
      write: (line) => headerLines.push(line),
    });
    const { response, headers } = fakeResponse();
    const request = {
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": ["", "  req-2  "] },
    } as unknown as IncomingMessage;

    createRequestListener({ logger: headerLogger })(request, response);

    expect(headers["x-request-id"]).toBe("req-2");
    expect(headerLines.join("")).toContain('"requestId":"req-2"');
  });
});
