import process from "node:process";
import type { LogLevel } from "./levels.ts";
import { levelEnabled, resolveLogLevel } from "./levels.ts";
import { redactPath, redactRecord, redactString } from "./redact.ts";

/**
 * Context attached to every line a logger (or one of its children) writes.
 * `requestId` and `runId` are the correlation ids: one of them is collapsed
 * into the record's `correlationId` field so a request or a run can be followed
 * across every line it touched.
 */
export interface LogContext {
  readonly service?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly [field: string]: unknown;
}

export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  /** Level threshold. Defaults to `LOG_LEVEL`, which defaults to `info`. */
  readonly level?: LogLevel;
  /** Shorthand for `context.service`, the process that writes the line. */
  readonly service?: string;
  readonly context?: LogContext;
  /** Environment map the level is read from. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Sink for finished lines. Defaults to `process.stdout`. */
  readonly write?: (line: string) => void;
  /** Clock override for tests. */
  readonly now?: () => Date;
}

export interface RequestLogFields {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly [field: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  readonly context: LogContext;
  /** A logger with the same sink and level, plus additional context. */
  child(context: LogContext): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /**
   * Logs one finished HTTP request at a level derived from the status:
   * `error` for 5xx, `warn` for 4xx, `info` otherwise. The path's sensitive
   * query parameters are redacted before the line is written.
   */
  request(fields: RequestLogFields): void;
}

const reservedKeys = new Set(["level", "timestamp", "msg", "correlationId"]);

// Event fields may not forge the record shape or the identity/correlation the
// context already established; those come from the context and the request.
const protectedFieldKeys = new Set([...reservedKeys, "service", "requestId", "runId"]);

function withoutKeys(
  record: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function correlationIdFor(context: LogContext): string | undefined {
  const runId = context["runId"];
  if (typeof runId === "string" && runId.length > 0) {
    return runId;
  }

  const requestId = context["requestId"];
  if (typeof requestId === "string" && requestId.length > 0) {
    return requestId;
  }

  return undefined;
}

function writeToStdout(line: string): void {
  process.stdout.write(line);
}

class JsonLogger implements Logger {
  readonly level: LogLevel;
  readonly context: LogContext;

  readonly #write: (line: string) => void;
  readonly #now: () => Date;

  constructor(options: LoggerOptions) {
    this.level = options.level ?? resolveLogLevel(options.env ?? process.env);
    this.context = {
      ...(options.service === undefined ? {} : { service: options.service }),
      ...options.context,
    };
    this.#write = options.write ?? writeToStdout;
    this.#now = options.now ?? ((): Date => new Date());
  }

  child(context: LogContext): Logger {
    return new JsonLogger({
      level: this.level,
      context: { ...this.context, ...context },
      write: this.#write,
      now: this.#now,
    });
  }

  debug(message: string, fields?: LogFields): void {
    this.#emit("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#emit("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#emit("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#emit("error", message, fields);
  }

  request(fields: RequestLogFields): void {
    const level: LogLevel = fields.status >= 500 ? "error" : fields.status >= 400 ? "warn" : "info";
    this.#emit(level, "request", { ...fields, path: redactPath(fields.path) });
  }

  #emit(level: LogLevel, message: string, fields: LogFields | undefined): void {
    if (!levelEnabled(level, this.level)) {
      return;
    }

    const timestamp = this.#now().toISOString();
    let record: Record<string, unknown>;

    try {
      record = this.#buildRecord(level, timestamp, message, fields);
    } catch (error) {
      // A logger must never take a process down. If a field refuses to
      // serialize (a throwing getter, a hostile object), write the failure
      // instead of the payload, still redacted.
      record = {
        level,
        timestamp,
        msg: "log record failed to serialize",
        logError: redactString(error instanceof Error ? error.message : String(error)),
      };
    }

    this.#write(`${JSON.stringify(record)}\n`);
  }

  #buildRecord(
    level: LogLevel,
    timestamp: string,
    message: string,
    fields: LogFields | undefined,
  ): Record<string, unknown> {
    const context = withoutKeys(redactRecord(this.context), reservedKeys);
    // Derived from the redacted context so a request id that happens to carry a
    // secret shape cannot leak through `correlationId`.
    const correlationId = correlationIdFor(context);
    const convertedFields =
      fields === undefined ? {} : withoutKeys(redactRecord(fields), protectedFieldKeys);

    return {
      level,
      timestamp,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...context,
      msg: redactString(message),
      ...convertedFields,
    };
  }
}

/** Creates a JSON logger. Every line is one object written to `write`. */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new JsonLogger(options);
}
