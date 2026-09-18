import { describe, expect, it } from "vitest";
import { createLogger, redactedPlaceholder, unredacted } from "./index.ts";
import type { Logger } from "./index.ts";

const timestamp = "2026-09-18T10:00:00.000Z";

function captureLogger(overrides: Parameters<typeof createLogger>[0] = {}): {
  logger: Logger;
  records: () => Record<string, unknown>[];
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createLogger({
    service: "@porkbot/test",
    write: (line) => lines.push(line),
    now: () => new Date(timestamp),
    ...overrides,
  });

  return {
    logger,
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("writes one JSON object per call with level, timestamp and message", () => {
    const { logger, lines, records } = captureLogger();

    logger.info("hello", { port: 3001 });
    logger.error("boom");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.trimEnd().includes("\n")).toBe(false);
    }

    expect(records()[0]).toMatchObject({
      level: "info",
      timestamp,
      msg: "hello",
      port: 3001,
      service: "@porkbot/test",
    });
    expect(records()[1]).toMatchObject({ level: "error", timestamp, msg: "boom" });
  });

  it("emits the timestamp as an ISO 8601 string", () => {
    const { logger, records } = captureLogger({ now: () => new Date() });

    logger.info("hello");

    const value = records()[0]?.["timestamp"];
    expect(typeof value).toBe("string");
    expect(Number.isNaN(Date.parse(value as string))).toBe(false);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("defaults to info and drops debug records", () => {
    const { logger, lines } = captureLogger();

    logger.debug("noise");
    logger.info("signal");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", msg: "signal" });
  });

  it("reads the level from the provided environment", () => {
    const { logger, lines } = captureLogger({ env: { LOG_LEVEL: "debug" } });

    logger.debug("noise");

    expect(lines).toHaveLength(1);
  });

  it("carries the request id as a correlation id from child loggers", () => {
    const { logger, records } = captureLogger();
    const request = logger.child({ requestId: "req-1" });

    request.info("handled");

    expect(records()[0]).toMatchObject({
      correlationId: "req-1",
      requestId: "req-1",
      service: "@porkbot/test",
    });
    expect(records()[0]).not.toHaveProperty("runId");
  });

  it("prefers the run id when a line belongs to both a request and a run", () => {
    const { logger, records } = captureLogger();

    logger.child({ requestId: "req-1", runId: "run-9" }).info("running");

    expect(records()[0]).toMatchObject({
      correlationId: "run-9",
      requestId: "req-1",
      runId: "run-9",
    });
  });

  it("does not let fields spoof level, timestamp, message, identity or correlation", () => {
    const { logger, records } = captureLogger();
    const request = logger.child({ requestId: "req-1" });

    request.warn("real", {
      level: "debug",
      timestamp: "nope",
      msg: "fake",
      correlationId: "spoofed",
      service: "spoofed",
      requestId: "spoofed",
      runId: "spoofed",
    });

    expect(records()[0]).toMatchObject({
      level: "warn",
      timestamp,
      msg: "real",
      correlationId: "req-1",
      service: "@porkbot/test",
      requestId: "req-1",
    });
    expect(records()[0]).not.toHaveProperty("runId");
  });

  it("redacts a correlation id that carries a secret shape", () => {
    const { logger, lines, records } = captureLogger();
    const request = logger.child({ requestId: "Bearer abcdefghijklmnop" });

    request.info("handled");

    expect(lines[0]).not.toContain("abcdefghijklmnop");
    expect(records()[0]).toMatchObject({
      correlationId: `Bearer ${redactedPlaceholder}`,
      requestId: `Bearer ${redactedPlaceholder}`,
    });
  });

  it("redacts sensitive fields and secret shapes in messages", () => {
    const { logger, records, lines } = captureLogger();

    logger.info("using token=abc123", {
      password: "hunter2",
      nested: { apiKey: "sk-secret-value" },
    });

    const line = lines[0] ?? "";
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("sk-secret-value");
    expect(records()[0]).toMatchObject({
      msg: `using token=${redactedPlaceholder}`,
      password: redactedPlaceholder,
      nested: { apiKey: redactedPlaceholder },
    });
  });

  it("keeps a sensitive field only through the explicit unredacted opt-in", () => {
    const { logger, records } = captureLogger();

    logger.info("rotated", { token: unredacted("sk-fake-token-value-123456") });

    expect(records()[0]).toMatchObject({ token: "sk-fake-token-value-123456" });
  });

  it("never throws when a field refuses to serialize", () => {
    const { logger, lines, records } = captureLogger();
    const hostile = {
      get boom(): never {
        throw new Error("token=abc123");
      },
    };

    expect(() => logger.info("hostile", hostile)).not.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("abc123");
    expect(records()[0]).toMatchObject({ level: "info", msg: "log record failed to serialize" });
  });
});

describe("logger.request", () => {
  it("logs the request with method, path, status and duration inside the correlation", () => {
    const { logger, records } = captureLogger();
    const request = logger.child({ requestId: "req-1" });

    request.request({ method: "GET", path: "/healthz", status: 200, durationMs: 3 });

    expect(records()[0]).toMatchObject({
      level: "info",
      msg: "request",
      method: "GET",
      path: "/healthz",
      status: 200,
      durationMs: 3,
      correlationId: "req-1",
    });
  });

  it("derives the level from the status: 5xx error, 4xx warn, otherwise info", () => {
    const { logger, records } = captureLogger();

    logger.request({ method: "GET", path: "/ok", status: 200, durationMs: 1 });
    logger.request({ method: "GET", path: "/missing", status: 404, durationMs: 1 });
    logger.request({ method: "POST", path: "/broken", status: 500, durationMs: 1 });

    expect(records().map((record) => record["level"])).toEqual(["info", "warn", "error"]);
  });

  it("redacts a credential carried in the query string", () => {
    const { logger, lines, records } = captureLogger();

    logger.request({
      method: "GET",
      path: "/oauth/callback?access_token=abc123&state=xyz",
      status: 302,
      durationMs: 2,
    });

    expect(lines[0]).not.toContain("abc123");
    expect(records()[0]).toMatchObject({
      path: `/oauth/callback?access_token=${redactedPlaceholder}&state=xyz`,
    });
  });
});

describe("logger.error", () => {
  it("redacts secrets in the error, its stack and its fields", () => {
    const { logger, lines, records } = captureLogger();
    const error = new Error("upstream rejected Bearer abcdefghijklmnop");
    error.stack = "Error: upstream rejected Bearer abcdefghijklmnop\n    at handler";

    logger.error("request failed", { error, password: "hunter2" });

    const line = lines[0] ?? "";
    expect(line).not.toContain("abcdefghijklmnop");
    expect(line).not.toContain("hunter2");
    expect(records()[0]).toMatchObject({
      level: "error",
      msg: "request failed",
      password: redactedPlaceholder,
      error: {
        name: "Error",
        message: `upstream rejected Bearer ${redactedPlaceholder}`,
        stack: `Error: upstream rejected Bearer ${redactedPlaceholder}\n    at handler`,
      },
    });
  });
});
