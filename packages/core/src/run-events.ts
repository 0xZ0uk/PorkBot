/**
 * The wire vocabulary of a run.
 *
 * `@porkbot/core` owns these types so the reducer and every transport share one
 * interpretation of the same stream. An event is untrusted input: it arrives as
 * parsed JSON, so `parseRunEvent` checks its shape and returns a typed error for
 * an unknown schema version, an unknown type or a malformed field. It never
 * skips an event silently.
 */

export const RUN_EVENT_SCHEMA_VERSION = 1;

export const RUN_EVENT_TYPES = [
  "run.started",
  "token.delta",
  "tool.requested",
  "tool.completed",
  "tool.failed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.steered",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

interface RunEventBase {
  readonly schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  /**
   * Position in the thread's stream. Contiguous and 1-based: the first event of
   * a thread is 1, and a gap means events are still missing. A reconnecting
   * subscription replays from its cursor, so the same `seq` can arrive twice.
   */
  readonly seq: number;
  readonly threadId: string;
  readonly runId: string;
}

export interface RunStartedEvent extends RunEventBase {
  readonly type: "run.started";
}

export interface TokenDeltaEvent extends RunEventBase {
  readonly type: "token.delta";
  readonly messageId: string;
  readonly delta: string;
}

export interface ToolRequestedEvent extends RunEventBase {
  readonly type: "tool.requested";
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
}

export interface ToolCompletedEvent extends RunEventBase {
  readonly type: "tool.completed";
  readonly callId: string;
  readonly result: unknown;
}

export interface ToolFailedEvent extends RunEventBase {
  readonly type: "tool.failed";
  readonly callId: string;
  readonly error: string;
}

export interface RunCompletedEvent extends RunEventBase {
  readonly type: "run.completed";
  /** The assistant message this completion closes, when the run produced one. */
  readonly messageId?: string;
}

export interface RunFailedEvent extends RunEventBase {
  readonly type: "run.failed";
  readonly error: string;
  readonly code?: string;
}

export interface RunCancelledEvent extends RunEventBase {
  readonly type: "run.cancelled";
  readonly reason?: string;
}

export interface RunSteeredEvent extends RunEventBase {
  readonly type: "run.steered";
  readonly messageId: string;
  readonly text: string;
}

export type RunEvent =
  | RunStartedEvent
  | TokenDeltaEvent
  | ToolRequestedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | RunSteeredEvent;

export function isRunEventType(value: unknown): value is RunEventType {
  return typeof value === "string" && (RUN_EVENT_TYPES as readonly string[]).includes(value);
}

export class RunEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunEventError";
  }
}

export class UnknownSchemaVersion extends RunEventError {
  readonly received: unknown;
  readonly supported: typeof RUN_EVENT_SCHEMA_VERSION;

  constructor(received: unknown) {
    super(
      `Unsupported run event schemaVersion: ${describeValue(received)} (supported: ${RUN_EVENT_SCHEMA_VERSION})`,
    );
    this.name = "UnknownSchemaVersion";
    this.received = received;
    this.supported = RUN_EVENT_SCHEMA_VERSION;
  }
}

export class UnknownEventType extends RunEventError {
  readonly received: unknown;

  constructor(received: unknown) {
    super(`Unknown run event type: ${describeValue(received)}`);
    this.name = "UnknownEventType";
    this.received = received;
  }
}

export class MalformedRunEvent extends RunEventError {
  readonly reason: string;
  readonly received: unknown;

  constructor(reason: string, received: unknown) {
    super(`Malformed run event: ${reason}`);
    this.name = "MalformedRunEvent";
    this.reason = reason;
    this.received = received;
  }
}

export type RunEventParseResult =
  | { readonly ok: true; readonly event: RunEvent }
  | { readonly ok: false; readonly error: RunEventError };

type Field<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MalformedRunEvent };

function describeValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "undefined":
      return "undefined";
    case "function":
      return "function";
    case "symbol":
      return "symbol";
    default:
      return value === null ? "null" : "object";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed<T>(reason: string, received: unknown): Field<T> {
  return { ok: false, error: new MalformedRunEvent(reason, received) };
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  options: { readonly allowEmpty?: boolean } = {},
): Field<string> {
  const value = record[field];
  const validType = typeof value === "string";
  const validLength = options.allowEmpty === true || (validType && value.length > 0);

  if (!validType || !validLength) {
    const expected = options.allowEmpty === true ? "a string" : "a non-empty string";
    return malformed(`${field} must be ${expected}`, value);
  }

  return { ok: true, value };
}

function optionalString(record: Record<string, unknown>, field: string): Field<string | undefined> {
  const value = record[field];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  return requireString(record, field);
}

function requirePresent(record: Record<string, unknown>, field: string): Field<unknown> {
  if (!Object.hasOwn(record, field)) {
    return malformed(`${field} must be present`, undefined);
  }

  return { ok: true, value: record[field] };
}

function parseBase(record: Record<string, unknown>): Field<RunEventBase> {
  const seq = record["seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    return malformed("seq must be a positive integer", seq);
  }

  const threadId = requireString(record, "threadId");
  if (!threadId.ok) {
    return threadId;
  }

  const runId = requireString(record, "runId");
  if (!runId.ok) {
    return runId;
  }

  return {
    ok: true,
    value: {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      seq,
      threadId: threadId.value,
      runId: runId.value,
    },
  };
}

function parseRunStarted(base: RunEventBase): RunEventParseResult {
  return { ok: true, event: { ...base, type: "run.started" } };
}

function parseTokenDelta(base: RunEventBase, record: Record<string, unknown>): RunEventParseResult {
  const messageId = requireString(record, "messageId");
  if (!messageId.ok) {
    return messageId;
  }

  const delta = requireString(record, "delta", { allowEmpty: true });
  if (!delta.ok) {
    return delta;
  }

  return {
    ok: true,
    event: { ...base, type: "token.delta", messageId: messageId.value, delta: delta.value },
  };
}

function parseToolRequested(
  base: RunEventBase,
  record: Record<string, unknown>,
): RunEventParseResult {
  const callId = requireString(record, "callId");
  if (!callId.ok) {
    return callId;
  }

  const tool = requireString(record, "tool");
  if (!tool.ok) {
    return tool;
  }

  const callArguments = requirePresent(record, "arguments");
  if (!callArguments.ok) {
    return callArguments;
  }

  return {
    ok: true,
    event: {
      ...base,
      type: "tool.requested",
      callId: callId.value,
      tool: tool.value,
      arguments: callArguments.value,
    },
  };
}

function parseToolCompleted(
  base: RunEventBase,
  record: Record<string, unknown>,
): RunEventParseResult {
  const callId = requireString(record, "callId");
  if (!callId.ok) {
    return callId;
  }

  const result = requirePresent(record, "result");
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    event: { ...base, type: "tool.completed", callId: callId.value, result: result.value },
  };
}

function parseToolFailed(base: RunEventBase, record: Record<string, unknown>): RunEventParseResult {
  const callId = requireString(record, "callId");
  if (!callId.ok) {
    return callId;
  }

  const error = requireString(record, "error", { allowEmpty: true });
  if (!error.ok) {
    return error;
  }

  return {
    ok: true,
    event: { ...base, type: "tool.failed", callId: callId.value, error: error.value },
  };
}

function parseRunCompleted(
  base: RunEventBase,
  record: Record<string, unknown>,
): RunEventParseResult {
  const messageId = optionalString(record, "messageId");
  if (!messageId.ok) {
    return messageId;
  }

  return {
    ok: true,
    event: {
      ...base,
      type: "run.completed",
      ...(messageId.value === undefined ? {} : { messageId: messageId.value }),
    },
  };
}

function parseRunFailed(base: RunEventBase, record: Record<string, unknown>): RunEventParseResult {
  const error = requireString(record, "error", { allowEmpty: true });
  if (!error.ok) {
    return error;
  }

  const code = optionalString(record, "code");
  if (!code.ok) {
    return code;
  }

  return {
    ok: true,
    event: {
      ...base,
      type: "run.failed",
      error: error.value,
      ...(code.value === undefined ? {} : { code: code.value }),
    },
  };
}

function parseRunCancelled(
  base: RunEventBase,
  record: Record<string, unknown>,
): RunEventParseResult {
  const reason = optionalString(record, "reason");
  if (!reason.ok) {
    return reason;
  }

  return {
    ok: true,
    event: {
      ...base,
      type: "run.cancelled",
      ...(reason.value === undefined ? {} : { reason: reason.value }),
    },
  };
}

function parseRunSteered(base: RunEventBase, record: Record<string, unknown>): RunEventParseResult {
  const messageId = requireString(record, "messageId");
  if (!messageId.ok) {
    return messageId;
  }

  const text = requireString(record, "text", { allowEmpty: true });
  if (!text.ok) {
    return text;
  }

  return {
    ok: true,
    event: { ...base, type: "run.steered", messageId: messageId.value, text: text.value },
  };
}

export function parseRunEvent(value: unknown): RunEventParseResult {
  if (!isRecord(value)) {
    return { ok: false, error: new MalformedRunEvent("event must be an object", value) };
  }

  if (value["schemaVersion"] !== RUN_EVENT_SCHEMA_VERSION) {
    return { ok: false, error: new UnknownSchemaVersion(value["schemaVersion"]) };
  }

  if (!isRunEventType(value["type"])) {
    return { ok: false, error: new UnknownEventType(value["type"]) };
  }

  const base = parseBase(value);
  if (!base.ok) {
    return base;
  }

  switch (value["type"]) {
    case "run.started":
      return parseRunStarted(base.value);
    case "token.delta":
      return parseTokenDelta(base.value, value);
    case "tool.requested":
      return parseToolRequested(base.value, value);
    case "tool.completed":
      return parseToolCompleted(base.value, value);
    case "tool.failed":
      return parseToolFailed(base.value, value);
    case "run.completed":
      return parseRunCompleted(base.value, value);
    case "run.failed":
      return parseRunFailed(base.value, value);
    case "run.cancelled":
      return parseRunCancelled(base.value, value);
    case "run.steered":
      return parseRunSteered(base.value, value);
  }
}
