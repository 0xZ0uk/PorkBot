import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent, RunEventType } from "@porkbot/core";

/**
 * The Pi-to-`RunEvent` translation table (slice 5.3, PRD decision 13).
 *
 * Pi owns the agent loop, and its canonical events are the only place Pi's
 * vocabulary is visible. This module is that boundary: it parses an untrusted
 * Pi event record, refuses anything it does not recognise with a typed error,
 * and maps the event onto the `RunEvent` wire vocabulary through one explicit,
 * tested table — so an upgrade that changes Pi's event shape fails loudly
 * instead of streaming a silently-wrong interpretation to every client.
 *
 * Why the parser is strict. `RunEvent` crosses a process and a product
 * boundary: a client reduces it, so a second interpretation of the same stream
 * is the bug the reducer exists to prevent. Pi events are parsed from the
 * pinned SDK, but a pin change is exactly the moment unknown fields appear, so
 * the parser refuses an unknown event type, an unknown top-level field, an
 * unknown nested `assistantMessageEvent` type, or a missing/mistyped field it
 * needs. `PI_EVENT_MAPPING` and `PI_EVENT_FIELDS` are typed against Pi's own
 * `AgentEvent` union, which makes "every canonical Pi event is classified" a
 * compile error rather than a review checklist.
 *
 * Mapping choices that are deliberate rather than mechanical:
 *
 * - `message_update` with a `text_delta` is the only delta that becomes
 *   `token.delta`. Thinking and tool-argument deltas are not transcript text;
 *   the tool call itself arrives completed as `tool_execution_start`, so
 *   emitting argument deltas would duplicate it.
 * - `tool_execution_start` / `tool_execution_end` become
 *   `tool.requested` / `tool.completed` / `tool.failed`; Pi's own
 *   `tool_execution_update` progress frame has no `RunEvent` and is dropped.
 * - `agent_end` is the terminal event, classified from the last assistant
 *   message's `stopReason`: `error` is `run.failed`, `aborted` is
 *   `run.cancelled`, and every completed reason is `run.completed`.
 *
 * `RunEvent` carries `schemaVersion`, so a future field cannot be smuggled in
 * silently; this adapter emits exactly the schema the core parser accepts.
 */

/**
 * Pi's stop-reason vocabulary. Written out rather than imported so no vendor
 * type escapes in this package's declarations; `pi-events.test.ts` asserts the
 * union equals Pi's own `AssistantMessage["stopReason"]`, so it cannot drift.
 */
export type PiStopReason =
  "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

/**
 * The `assistantMessageEvent` discriminants, written out for the same reason
 * and asserted against Pi's own union in the test suite.
 */
export type PiAssistantMessageEventType =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "toolcall_start"
  | "toolcall_delta"
  | "toolcall_end"
  | "done"
  | "error";

/**
 * What one canonical Pi event means to the boundary. `emits` is the complete
 * set of `RunEvent` types the event can produce, so the table doubles as the
 * documentation a reviewer reads and the test that follows asserts exhaustively.
 */
export interface PiEventMapping {
  /** `RunEvent` types this Pi event can produce; empty means "intentionally none". */
  readonly emits: readonly RunEventType[];
  /** Whether this is the run's one terminal event. */
  readonly terminal: boolean;
  /** Why the mapping is what it is, in one line. */
  readonly description: string;
}

/**
 * The mapping table, checked against Pi's `AgentEvent` union. Adding,
 * removing or renaming a canonical event in a Pi version makes this fail to
 * compile until the adapter is updated on purpose.
 */
export const PI_EVENT_MAPPING = {
  agent_start: {
    emits: ["run.started"],
    terminal: false,
    description: "Pi begins processing a prompt: the run is now running.",
  },
  agent_end: {
    emits: ["run.completed", "run.failed", "run.cancelled"],
    terminal: true,
    description: "The last event of a run; its last assistant stopReason picks the terminal type.",
  },
  turn_start: {
    emits: [],
    terminal: false,
    description: "One model call plus tool executions begins; no wire event of its own.",
  },
  turn_end: {
    emits: [],
    terminal: false,
    description: "A turn's assistant message completes; token and tool events already carried it.",
  },
  message_start: {
    emits: [],
    terminal: false,
    description: "A message begins; only assistant messages allocate a transcript id.",
  },
  message_update: {
    emits: ["token.delta"],
    terminal: false,
    description:
      "Assistant text deltas stream as token.delta; thinking/tool deltas are not transcript text.",
  },
  message_end: {
    emits: [],
    terminal: false,
    description:
      "A message completes; an assistant message's final usage is carried beside the events, and completion is signalled by agent_end.",
  },
  tool_execution_start: {
    emits: ["tool.requested"],
    terminal: false,
    description: "The completed tool call and its validated arguments.",
  },
  tool_execution_update: {
    emits: [],
    terminal: false,
    description: "Tool progress has no RunEvent vocabulary and is dropped.",
  },
  tool_execution_end: {
    emits: ["tool.completed", "tool.failed"],
    terminal: false,
    description: "The tool result, or the failure Pi reports with isError.",
  },
} satisfies Record<string, PiEventMapping>;

/**
 * The canonical Pi event types this adapter knows, derived from the table. The
 * test suite asserts this equals Pi's `AgentEvent["type"]`, so adding one in a
 * pin change without classifying it here fails the build.
 */
export type PiEventType = keyof typeof PI_EVENT_MAPPING;

/**
 * The exact top-level fields each Pi event may carry. Every other own field is
 * `UnknownPiEventField`: a pin bump that adds a field must be reviewed against
 * the mapping rather than ignored, which is the point of a recorded corpus.
 */
const PI_EVENT_FIELDS = {
  agent_start: ["type"],
  agent_end: ["type", "messages"],
  turn_start: ["type"],
  turn_end: ["type", "message", "toolResults"],
  message_start: ["type", "message"],
  message_update: ["type", "message", "assistantMessageEvent"],
  message_end: ["type", "message"],
  tool_execution_start: ["type", "toolCallId", "toolName", "args"],
  tool_execution_update: ["type", "toolCallId", "toolName", "args", "partialResult"],
  tool_execution_end: ["type", "toolCallId", "toolName", "result", "isError"],
} satisfies Record<PiEventType, readonly string[]>;

const PI_ASSISTANT_MESSAGE_EVENT_TYPES = [
  "start",
  "text_start",
  "text_delta",
  "text_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
  "done",
  "error",
] as const satisfies readonly PiAssistantMessageEventType[];

const PI_STOP_REASONS = [
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
] as const satisfies readonly PiStopReason[];

const assistantMessageEventTypes: ReadonlySet<string> = new Set(PI_ASSISTANT_MESSAGE_EVENT_TYPES);
const stopReasons: ReadonlySet<string> = new Set(PI_STOP_REASONS);

/**
 * Base class for every refusal this boundary makes. A translation failure is an
 * adapter concern, not a wire error: it is raised before any `RunEvent` exists.
 */
export class PiEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiEventError";
  }
}

/** The event's `type` is not a canonical Pi event this adapter maps. */
export class UnknownPiEventType extends PiEventError {
  readonly received: unknown;

  constructor(received: unknown) {
    super(`Unknown Pi event type: ${describeValue(received)}`);
    this.name = "UnknownPiEventType";
    this.received = received;
  }
}

/** The event carries a top-level field the mapping table does not name. */
export class UnknownPiEventField extends PiEventError {
  readonly eventType: PiEventType;
  readonly field: string;

  constructor(eventType: PiEventType, field: string) {
    super(`Unknown field "${field}" on Pi event "${eventType}"`);
    this.name = "UnknownPiEventField";
    this.eventType = eventType;
    this.field = field;
  }
}

/** A `message_update` carries an `assistantMessageEvent` type this adapter does not know. */
export class UnknownPiMessageEventType extends PiEventError {
  readonly received: unknown;

  constructor(received: unknown) {
    super(`Unknown Pi assistant message event type: ${describeValue(received)}`);
    this.name = "UnknownPiMessageEventType";
    this.received = received;
  }
}

/** The event or one of the fields the mapping reads is missing or mistyped. */
export class MalformedPiEvent extends PiEventError {
  readonly eventType: string;
  readonly reason: string;
  readonly received: unknown;

  constructor(eventType: string, reason: string, received: unknown) {
    super(`Malformed Pi event "${eventType}": ${reason}`);
    this.name = "MalformedPiEvent";
    this.eventType = eventType;
    this.reason = reason;
    this.received = received;
  }
}

/** Events arrived in an order the run's state machine forbids. */
export class PiEventSequenceError extends PiEventError {
  readonly reason: string;

  constructor(reason: string) {
    super(`Pi event sequence error: ${reason}`);
    this.name = "PiEventSequenceError";
    this.reason = reason;
  }
}

/**
 * One completed assistant message's usage as the adapter reads it (slice 8.8,
 * story 34). `provider` and `model` are the names Pi put on the message when it
 * had them; the token counts are null where the provider reported nothing.
 *
 * Pi initialises a streamed message's usage to all zeros and replaces it only
 * when a usage chunk arrives, so an all-zero report is Pi's stand-in for "the
 * provider did not report" — it must degrade to null rather than become a
 * measured zero. That distinction lives in `parseMessageUsage` below.
 */
export interface PiUsageReport {
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** A validated Pi event, narrowed to the fields the mapping needs. */
export type ParsedPiEvent =
  | { readonly type: "agent_start" }
  | {
      readonly type: "agent_end";
      readonly stopReason: PiStopReason;
      readonly errorMessage?: string;
    }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end" }
  | { readonly type: "message_start"; readonly role: string }
  | {
      readonly type: "message_update";
      readonly role: string;
      readonly update: { readonly type: PiAssistantMessageEventType; readonly delta?: string };
    }
  | {
      readonly type: "message_end";
      readonly role: string;
      /** Present for an assistant message: the model call's usage, never a fake zero. */
      readonly usageReport?: PiUsageReport;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | { readonly type: "tool_execution_update"; readonly toolCallId: string }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError: boolean;
    };

export type PiEventParseResult =
  | { readonly ok: true; readonly event: ParsedPiEvent }
  | { readonly ok: false; readonly error: PiEventError };

interface FieldFailure {
  readonly ok: false;
  readonly error: PiEventError;
}

type Field<T> = { readonly ok: true; readonly value: T } | FieldFailure;

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

function malformed(eventType: string, reason: string, received: unknown): FieldFailure {
  return { ok: false, error: new MalformedPiEvent(eventType, reason, received) };
}

function requireString(
  record: Record<string, unknown>,
  eventType: string,
  field: string,
): Field<string> {
  const value = record[field];

  if (typeof value !== "string" || value.length === 0) {
    return malformed(eventType, `${field} must be a non-empty string`, value);
  }

  return { ok: true, value };
}

function requirePresent(
  record: Record<string, unknown>,
  eventType: string,
  field: string,
): Field<unknown> {
  if (!Object.hasOwn(record, field)) {
    return malformed(eventType, `${field} must be present`, undefined);
  }

  return { ok: true, value: record[field] };
}

function parseMessageRole(record: Record<string, unknown>, eventType: string): Field<string> {
  const message = record["message"];

  if (!isRecord(message)) {
    return malformed(eventType, "message must be an object", message);
  }

  const role = message["role"];

  if (typeof role !== "string" || role.length === 0) {
    return malformed(eventType, "message.role must be a non-empty string", role);
  }

  return { ok: true, value: role };
}

/** A non-empty string field, or null when absent, blank or mistyped. */
function optionalName(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A non-negative integer token count, or null when absent or mistyped. */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Reads one completed assistant message's usage. The parse is deliberately
 * lenient where the strict event parser is not: usage is observability, and a
 * provider whose usage shape this adapter does not understand must cost the
 * operator a figure, never a run. Anything missing or mistyped becomes null —
 * "not reported" — and the call is still recorded, so the ledger counts the
 * call and says its tokens are unknown.
 */
function parseMessageUsage(message: Record<string, unknown>): PiUsageReport {
  const provider = optionalName(message["provider"]);
  const model = optionalName(message["model"]);
  const usage = message["usage"];

  if (!isRecord(usage)) {
    return { provider, model, inputTokens: null, outputTokens: null };
  }

  const input = tokenCount(usage["input"]);
  const output = tokenCount(usage["output"]);
  const cacheRead = tokenCount(usage["cacheRead"]);
  const cacheWrite = tokenCount(usage["cacheWrite"]);
  const total = tokenCount(usage["totalTokens"]);

  // All-zero is Pi's zero value, not a measurement: a streamed message keeps
  // the initialised usage when the provider's stream carries no usage chunk.
  // A call that truly spent nothing is not a thing, so this degrades to null
  // rather than reporting a fake zero (story 34's acceptance criterion).
  //
  // Pi's `input` already excludes cache reads and writes, so a cache-only
  // report (input and output zero, cache nonzero) is a real measurement and is
  // recorded as reported zeros — the ledger stores what the provider said
  // rather than re-deriving a number Pi did not report.
  if (
    (input ?? 0) === 0 &&
    (output ?? 0) === 0 &&
    (cacheRead ?? 0) === 0 &&
    (cacheWrite ?? 0) === 0 &&
    (total ?? 0) === 0
  ) {
    return { provider, model, inputTokens: null, outputTokens: null };
  }

  return { provider, model, inputTokens: input, outputTokens: output };
}

/** A `message_end` with an assistant role carries the call's usage; others do not. */
function parseMessageEnd(record: Record<string, unknown>): PiEventParseResult {
  const role = parseMessageRole(record, "message_end");

  if (!role.ok) {
    return role;
  }

  if (role.value !== "assistant") {
    return { ok: true, event: { type: "message_end", role: role.value } };
  }

  const message = record["message"];

  return {
    ok: true,
    event: {
      type: "message_end",
      role: role.value,
      usageReport: parseMessageUsage(isRecord(message) ? message : {}),
    },
  };
}

function parseAgentEnd(record: Record<string, unknown>): PiEventParseResult {
  const messages = record["messages"];

  if (!Array.isArray(messages)) {
    return {
      ok: false,
      error: new MalformedPiEvent("agent_end", "messages must be an array", messages),
    };
  }

  let stopReason: PiStopReason = "stop";
  let errorMessage: string | undefined;

  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") {
      continue;
    }

    const candidate = message["stopReason"];
    if (typeof candidate === "string" && stopReasons.has(candidate)) {
      stopReason = candidate as PiStopReason;
    }

    const error = message["errorMessage"];
    if (typeof error === "string") {
      errorMessage = error;
    }
  }

  return {
    ok: true,
    event: {
      type: "agent_end",
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
  };
}

function parseMessageUpdate(record: Record<string, unknown>): PiEventParseResult {
  const role = parseMessageRole(record, "message_update");
  if (!role.ok) {
    return role;
  }

  const update = record["assistantMessageEvent"];

  if (!isRecord(update)) {
    return malformed("message_update", "assistantMessageEvent must be an object", update);
  }

  const updateType = update["type"];

  if (typeof updateType !== "string" || !assistantMessageEventTypes.has(updateType)) {
    return { ok: false, error: new UnknownPiMessageEventType(updateType) };
  }

  if (updateType === "text_delta") {
    const delta = update["delta"];

    if (typeof delta !== "string") {
      return malformed(
        "message_update",
        "assistantMessageEvent.delta must be a string for text_delta",
        delta,
      );
    }

    return {
      ok: true,
      event: { type: "message_update", role: role.value, update: { type: "text_delta", delta } },
    };
  }

  return {
    ok: true,
    event: {
      type: "message_update",
      role: role.value,
      update: { type: updateType as PiAssistantMessageEventType },
    },
  };
}

function parseToolCallId(record: Record<string, unknown>, eventType: string): Field<string> {
  return requireString(record, eventType, "toolCallId");
}

/**
 * Parses one untrusted Pi event record. The caller passes exactly what arrived
 * across the SDK boundary — a JSON-shaped value, not a typed object — so an
 * unknown shape is refused here and never reaches the mapping.
 */
export function parsePiEvent(value: unknown): PiEventParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: new MalformedPiEvent("event", "the event must be an object", value),
    };
  }

  const rawType = value["type"];

  if (typeof rawType !== "string" || !Object.hasOwn(PI_EVENT_MAPPING, rawType)) {
    return { ok: false, error: new UnknownPiEventType(rawType) };
  }

  const type = rawType as PiEventType;
  const allowed = PI_EVENT_FIELDS[type];

  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return { ok: false, error: new UnknownPiEventField(type, key) };
    }
  }

  switch (type) {
    case "agent_start":
      return { ok: true, event: { type: "agent_start" } };
    case "turn_start":
      return { ok: true, event: { type: "turn_start" } };
    case "turn_end":
      return { ok: true, event: { type: "turn_end" } };
    case "agent_end":
      return parseAgentEnd(value);
    case "message_start": {
      const role = parseMessageRole(value, "message_start");
      return role.ok ? { ok: true, event: { type: "message_start", role: role.value } } : role;
    }
    case "message_end":
      return parseMessageEnd(value);
    case "message_update":
      return parseMessageUpdate(value);
    case "tool_execution_start": {
      const toolCallId = parseToolCallId(value, "tool_execution_start");
      if (!toolCallId.ok) {
        return toolCallId;
      }

      const toolName = requireString(value, "tool_execution_start", "toolName");
      if (!toolName.ok) {
        return toolName;
      }

      const args = requirePresent(value, "tool_execution_start", "args");
      if (!args.ok) {
        return args;
      }

      return {
        ok: true,
        event: {
          type: "tool_execution_start",
          toolCallId: toolCallId.value,
          toolName: toolName.value,
          args: args.value,
        },
      };
    }
    case "tool_execution_update": {
      const toolCallId = parseToolCallId(value, "tool_execution_update");
      return toolCallId.ok
        ? { ok: true, event: { type: "tool_execution_update", toolCallId: toolCallId.value } }
        : toolCallId;
    }
    case "tool_execution_end": {
      const toolCallId = parseToolCallId(value, "tool_execution_end");
      if (!toolCallId.ok) {
        return toolCallId;
      }

      const toolName = requireString(value, "tool_execution_end", "toolName");
      if (!toolName.ok) {
        return toolName;
      }

      const result = requirePresent(value, "tool_execution_end", "result");
      if (!result.ok) {
        return result;
      }

      const isError = value["isError"];
      if (typeof isError !== "boolean") {
        return malformed("tool_execution_end", "isError must be a boolean", isError);
      }

      return {
        ok: true,
        event: {
          type: "tool_execution_end",
          toolCallId: toolCallId.value,
          toolName: toolName.value,
          result: result.value,
          isError,
        },
      };
    }
  }
}

/** Where a translated run's events slot into the thread's stream. */
export interface PiTranslationBase {
  readonly threadId: string;
  readonly runId: string;
  /** The next per-thread sequence the translator allocates from. */
  readonly startSeq: number;
}

export type PiTranslationResult =
  | {
      readonly ok: true;
      readonly events: readonly RunEvent[];
      readonly terminal: boolean;
      /**
       * A completed assistant message's usage, when one arrived. It is not a
       * `RunEvent` — usage is not transcript — so it travels beside the events
       * the caller already drains, and the runtime reports it through the
       * usage seam (PRD story 34).
       */
      readonly usageReport?: PiUsageReport;
    }
  | { readonly ok: false; readonly error: PiEventError };

/**
 * Turns a sequence of parsed Pi events into `RunEvent`s, allocating the
 * thread's `seq` and the transcript ids Pi does not carry.
 *
 * The translator is stateful on purpose: `seq` is contiguous, an assistant
 * message id is allocated when its `message_start` arrives, and a terminal
 * event closes the run so a later event is a typed sequence error rather than
 * a second completion. Everything it emits is a valid `RunEvent` for the
 * thread it was constructed with.
 */
export class PiRunTranslator {
  private readonly base: PiTranslationBase;
  private nextSeq: number;
  private assistantMessages = 0;
  private currentAssistantId: string | undefined;
  private terminalReached = false;
  private hasStarted = false;

  constructor(base: PiTranslationBase) {
    this.base = base;
    this.nextSeq = base.startSeq;
  }

  /** The seq the next emitted event will carry. */
  get seq(): number {
    return this.nextSeq;
  }

  /** Whether a terminal `RunEvent` has been produced. */
  get terminal(): boolean {
    return this.terminalReached;
  }

  /** Whether `agent_start` has been translated to `run.started`. */
  get started(): boolean {
    return this.hasStarted;
  }

  /** The transcript id of the assistant message currently streaming, if any. */
  get assistantMessageId(): string | undefined {
    return this.currentAssistantId;
  }

  /** Reserves the next contiguous seq for an event the session synthesizes. */
  allocateSeq(): number {
    return this.nextSeq++;
  }

  translate(value: unknown): PiTranslationResult {
    const parsed = parsePiEvent(value);

    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const event = parsed.event;

    if (this.terminalReached) {
      return {
        ok: false,
        error: new PiEventSequenceError(
          `a ${event.type} event arrived after the run's terminal event`,
        ),
      };
    }

    switch (event.type) {
      case "agent_start": {
        if (this.hasStarted) {
          return { ok: false, error: new PiEventSequenceError("agent_start arrived twice") };
        }

        this.hasStarted = true;
        return this.emit((seq) => ({ ...this.frame(seq), type: "run.started" }));
      }
      case "message_start": {
        if (event.role === "assistant") {
          this.beginAssistant();
        }

        return { ok: true, events: [], terminal: false };
      }
      case "message_update": {
        if (event.update.type !== "text_delta") {
          return { ok: true, events: [], terminal: false };
        }

        const messageId = this.currentAssistantId ?? this.beginAssistant();

        return this.emit((seq) => ({
          ...this.frame(seq),
          type: "token.delta",
          messageId,
          delta: event.update.delta ?? "",
        }));
      }
      case "tool_execution_start":
        return this.emit((seq) => ({
          ...this.frame(seq),
          type: "tool.requested",
          callId: event.toolCallId,
          tool: event.toolName,
          arguments: event.args,
        }));
      case "tool_execution_end":
        return event.isError
          ? this.emit((seq) => ({
              ...this.frame(seq),
              type: "tool.failed",
              callId: event.toolCallId,
              error: toolErrorText(event.result, event.toolName),
            }))
          : this.emit((seq) => ({
              ...this.frame(seq),
              type: "tool.completed",
              callId: event.toolCallId,
              result: event.result,
            }));
      case "message_end": {
        const report = event.usageReport;

        return report === undefined
          ? { ok: true, events: [], terminal: false }
          : { ok: true, events: [], terminal: false, usageReport: report };
      }
      case "agent_end":
        return this.endRun(event.stopReason, event.errorMessage);
      case "turn_start":
      case "turn_end":
      case "tool_execution_update":
        return { ok: true, events: [], terminal: false };
    }
  }

  /** Classifies Pi's terminal event from the last assistant turn's stop reason. */
  private endRun(stopReason: PiStopReason, errorMessage: string | undefined): PiTranslationResult {
    const messageId = this.currentAssistantId;

    switch (stopReason) {
      case "error":
        return this.end((seq) => ({
          ...this.frame(seq),
          type: "run.failed",
          error: errorMessage ?? "the Pi agent turn failed",
        }));
      case "aborted":
        return this.end((seq) => ({
          ...this.frame(seq),
          type: "run.cancelled",
          reason: errorMessage ?? "aborted",
        }));
      case "stop":
      case "length":
      case "toolUse":
        return this.end((seq) => ({
          ...this.frame(seq),
          type: "run.completed",
          ...(messageId === undefined ? {} : { messageId }),
        }));
      case "pending":
      case "deferred":
        return {
          ok: false,
          error: new PiEventSequenceError(
            `agent_end arrived with a non-terminal stopReason "${stopReason}"`,
          ),
        };
    }
  }

  private frame(seq: number) {
    return {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      seq,
      threadId: this.base.threadId,
      runId: this.base.runId,
    } as const;
  }

  private beginAssistant(): string {
    this.assistantMessages += 1;
    this.currentAssistantId = `assistant-${this.assistantMessages}`;
    return this.currentAssistantId;
  }

  private emit(build: (seq: number) => RunEvent): PiTranslationResult {
    const seq = this.nextSeq++;
    return { ok: true, events: [build(seq)], terminal: false };
  }

  private end(build: (seq: number) => RunEvent): PiTranslationResult {
    this.terminalReached = true;
    const seq = this.nextSeq++;
    return { ok: true, events: [build(seq)], terminal: true };
  }
}

function toolErrorText(result: unknown, toolName: string): string {
  if (isRecord(result)) {
    const content = result["content"];

    if (Array.isArray(content)) {
      const texts = content.flatMap((part) =>
        isRecord(part) && part["type"] === "text" && typeof part["text"] === "string"
          ? [part["text"]]
          : [],
      );

      if (texts.length > 0) {
        return texts.join("\n");
      }
    }
  }

  return `the Pi tool "${toolName}" failed`;
}
