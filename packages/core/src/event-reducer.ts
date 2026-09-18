import { INITIAL_RUN_STATUS, transition } from "./run-state.ts";
import type { RunStatus } from "./run-state.ts";
import { RunEventError, parseRunEvent } from "./run-events.ts";
import type {
  RunCancelledEvent,
  RunCompletedEvent,
  RunEvent,
  RunFailedEvent,
  RunStartedEvent,
  RunSteeredEvent,
  TokenDeltaEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolRequestedEvent,
  ToolResultArtifact,
} from "./run-events.ts";

/**
 * Folds run events into the thread snapshot a client renders.
 *
 * The fold is pure: the same event list always produces the same snapshot,
 * whatever order it arrives in and however many times an event is replayed.
 * Events are ordered by their per-thread `seq`; one that is ahead of the cursor
 * is buffered until the gap fills, and one at or below the cursor is a replay
 * and changes nothing. Every anomaly — a foreign thread, an illegal run
 * transition, a result for an unknown tool call — is a typed error rather than
 * a silent repair, because a client that guesses is a second interpretation of
 * the stream.
 */

export interface MessageSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly role: "assistant" | "user";
  readonly text: string;
  readonly complete: boolean;
}

export interface ToolCallSnapshot {
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly status: "requested" | "completed" | "failed";
  readonly result?: unknown;
  /** Where the whole result lives when the event carried only a preview. */
  readonly resultArtifact?: ToolResultArtifact;
  readonly error?: string;
  /** Wall-clock duration of the call once it settled, in milliseconds. */
  readonly durationMs?: number;
}

export interface RunFailureSnapshot {
  readonly message: string;
  readonly code?: string;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly status: RunStatus;
  readonly toolCalls: readonly ToolCallSnapshot[];
  readonly failure?: RunFailureSnapshot;
  readonly cancelReason?: string;
}

export interface ThreadSnapshot {
  readonly threadId: string;
  readonly runs: readonly RunSnapshot[];
  readonly messages: readonly MessageSnapshot[];
  /** Seq of the last contiguous event applied; 0 means none. */
  readonly lastSeq: number;
  /** Parsed events ahead of `lastSeq`, ordered by seq, waiting for the gap to fill. */
  readonly pendingEvents: readonly RunEvent[];
}

export interface CreateThreadSnapshotOptions {
  /**
   * The cursor a client already holds, so a subscription can resume. Defaults
   * to 0: the snapshot expects the thread's first event to be seq 1.
   */
  readonly lastSeq?: number;
}

export class ThreadMismatch extends RunEventError {
  readonly expectedThreadId: string;
  readonly receivedThreadId: string;

  constructor(expectedThreadId: string, receivedThreadId: string) {
    super(
      `Run event is for thread "${receivedThreadId}", but this snapshot is for thread "${expectedThreadId}"`,
    );
    this.name = "ThreadMismatch";
    this.expectedThreadId = expectedThreadId;
    this.receivedThreadId = receivedThreadId;
  }
}

export class IllegalEventTransition extends RunEventError {
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus) {
    super(`Illegal run transition: ${from} -> ${to}`);
    this.name = "IllegalEventTransition";
    this.from = from;
    this.to = to;
  }
}

export class UnknownToolCall extends RunEventError {
  readonly callId: string;

  constructor(callId: string) {
    super(`Run event references unknown tool call "${callId}"`);
    this.name = "UnknownToolCall";
    this.callId = callId;
  }
}

export class ToolCallConflict extends RunEventError {
  readonly callId: string;
  readonly reason: "duplicate_request" | "already_resolved";

  constructor(callId: string, reason: "duplicate_request" | "already_resolved") {
    super(`Tool call "${callId}" is in conflict: ${reason}`);
    this.name = "ToolCallConflict";
    this.callId = callId;
    this.reason = reason;
  }
}

export class MessageConflict extends RunEventError {
  readonly messageId: string;
  readonly reason: "not_assistant" | "already_exists";

  constructor(messageId: string, reason: "not_assistant" | "already_exists") {
    super(`Message "${messageId}" is in conflict: ${reason}`);
    this.name = "MessageConflict";
    this.messageId = messageId;
    this.reason = reason;
  }
}

export type ReduceRunEventResult =
  | { readonly ok: true; readonly snapshot: ThreadSnapshot }
  | { readonly ok: false; readonly error: RunEventError };

export function createThreadSnapshot(
  threadId: string,
  options: CreateThreadSnapshotOptions = {},
): ThreadSnapshot {
  const lastSeq = options.lastSeq ?? 0;
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
    throw new RangeError(
      `lastSeq must be a non-negative safe integer, received ${String(lastSeq)}`,
    );
  }

  return { threadId, runs: [], messages: [], lastSeq, pendingEvents: [] };
}

function failure(error: RunEventError): ReduceRunEventResult {
  return { ok: false, error };
}

function findRun(snapshot: ThreadSnapshot, runId: string): RunSnapshot | undefined {
  return snapshot.runs.find((run) => run.runId === runId);
}

function findMessage(snapshot: ThreadSnapshot, messageId: string): MessageSnapshot | undefined {
  return snapshot.messages.find((message) => message.id === messageId);
}

function withRun(snapshot: ThreadSnapshot, run: RunSnapshot): ThreadSnapshot {
  const exists = snapshot.runs.some((candidate) => candidate.runId === run.runId);
  const runs = exists
    ? snapshot.runs.map((candidate) => (candidate.runId === run.runId ? run : candidate))
    : [...snapshot.runs, run];

  return { ...snapshot, runs };
}

function withMessage(snapshot: ThreadSnapshot, message: MessageSnapshot): ThreadSnapshot {
  const exists = snapshot.messages.some((candidate) => candidate.id === message.id);
  const messages = exists
    ? snapshot.messages.map((candidate) => (candidate.id === message.id ? message : candidate))
    : [...snapshot.messages, message];

  return { ...snapshot, messages };
}

type RunStep =
  | { readonly ok: true; readonly snapshot: ThreadSnapshot; readonly run: RunSnapshot }
  | { readonly ok: false; readonly error: RunEventError };

function asRunning(snapshot: ThreadSnapshot, runId: string): RunStep {
  const existing = findRun(snapshot, runId);
  const run = existing ?? { runId, status: INITIAL_RUN_STATUS, toolCalls: [] };

  if (run.status === "running") {
    return { ok: true, snapshot: existing === undefined ? withRun(snapshot, run) : snapshot, run };
  }

  const outcome = transition(run.status, "running");
  if (!outcome.ok) {
    return { ok: false, error: new IllegalEventTransition(run.status, "running") };
  }

  const next: RunSnapshot = { ...run, status: outcome.status };
  return { ok: true, snapshot: withRun(snapshot, next), run: next };
}

function asTerminal(
  snapshot: ThreadSnapshot,
  runId: string,
  status: "completed" | "failed" | "cancelled",
): RunStep {
  const existing = findRun(snapshot, runId);
  const run = existing ?? { runId, status: INITIAL_RUN_STATUS, toolCalls: [] };
  const outcome = transition(run.status, status);

  if (!outcome.ok) {
    return { ok: false, error: new IllegalEventTransition(run.status, status) };
  }

  const next: RunSnapshot = { ...run, status: outcome.status };
  return { ok: true, snapshot: withRun(snapshot, next), run: next };
}

function completeRunMessages(
  snapshot: ThreadSnapshot,
  runId: string,
  messageId: string | undefined,
): ReduceRunEventResult {
  let current = snapshot;

  if (messageId !== undefined) {
    const message = findMessage(current, messageId);
    if (message === undefined) {
      const created: MessageSnapshot = {
        id: messageId,
        runId,
        role: "assistant",
        text: "",
        complete: true,
      };

      current = withMessage(current, created);
    } else if (message.role !== "assistant") {
      return failure(new MessageConflict(messageId, "not_assistant"));
    }
  }

  const messages = current.messages.map((message) =>
    message.runId === runId && message.role === "assistant"
      ? { ...message, complete: true }
      : message,
  );

  return { ok: true, snapshot: { ...current, messages } };
}

function reduceRunStarted(snapshot: ThreadSnapshot, event: RunStartedEvent): ReduceRunEventResult {
  const existing = findRun(snapshot, event.runId);
  const run = existing ?? { runId: event.runId, status: INITIAL_RUN_STATUS, toolCalls: [] };
  const outcome = transition(run.status, "running");

  if (!outcome.ok) {
    return failure(new IllegalEventTransition(run.status, "running"));
  }

  const next: RunSnapshot = { ...run, status: outcome.status };

  return { ok: true, snapshot: withRun(snapshot, next) };
}

function reduceTokenDelta(snapshot: ThreadSnapshot, event: TokenDeltaEvent): ReduceRunEventResult {
  const running = asRunning(snapshot, event.runId);
  if (!running.ok) {
    return running;
  }

  const message = findMessage(running.snapshot, event.messageId);
  if (message === undefined) {
    const created: MessageSnapshot = {
      id: event.messageId,
      runId: event.runId,
      role: "assistant",
      text: event.delta,
      complete: false,
    };

    return { ok: true, snapshot: withMessage(running.snapshot, created) };
  }

  if (message.role !== "assistant") {
    return failure(new MessageConflict(event.messageId, "not_assistant"));
  }

  return {
    ok: true,
    snapshot: withMessage(running.snapshot, { ...message, text: message.text + event.delta }),
  };
}

function reduceToolRequested(
  snapshot: ThreadSnapshot,
  event: ToolRequestedEvent,
): ReduceRunEventResult {
  const running = asRunning(snapshot, event.runId);
  if (!running.ok) {
    return running;
  }

  if (running.run.toolCalls.some((call) => call.callId === event.callId)) {
    return failure(new ToolCallConflict(event.callId, "duplicate_request"));
  }

  const call: ToolCallSnapshot = {
    callId: event.callId,
    tool: event.tool,
    arguments: event.arguments,
    status: "requested",
  };
  const run: RunSnapshot = { ...running.run, toolCalls: [...running.run.toolCalls, call] };

  return { ok: true, snapshot: withRun(running.snapshot, run) };
}

function reduceToolResolution(
  snapshot: ThreadSnapshot,
  event: ToolCompletedEvent | ToolFailedEvent,
): ReduceRunEventResult {
  const run = findRun(snapshot, event.runId);
  const call = run?.toolCalls.find((candidate) => candidate.callId === event.callId);
  if (run === undefined || call === undefined) {
    return failure(new UnknownToolCall(event.callId));
  }

  if (call.status !== "requested") {
    return failure(new ToolCallConflict(event.callId, "already_resolved"));
  }

  const resolved: ToolCallSnapshot =
    event.type === "tool.completed"
      ? {
          ...call,
          status: "completed",
          result: event.result,
          ...(event.resultArtifact === undefined ? {} : { resultArtifact: event.resultArtifact }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        }
      : {
          ...call,
          status: "failed",
          error: event.error,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        };
  const toolCalls = run.toolCalls.map((candidate) =>
    candidate.callId === event.callId ? resolved : candidate,
  );

  return { ok: true, snapshot: withRun(snapshot, { ...run, toolCalls }) };
}

function reduceRunCompleted(
  snapshot: ThreadSnapshot,
  event: RunCompletedEvent,
): ReduceRunEventResult {
  const ended = asTerminal(snapshot, event.runId, "completed");
  if (!ended.ok) {
    return ended;
  }

  return completeRunMessages(ended.snapshot, event.runId, event.messageId);
}

function reduceRunFailed(snapshot: ThreadSnapshot, event: RunFailedEvent): ReduceRunEventResult {
  const ended = asTerminal(snapshot, event.runId, "failed");
  if (!ended.ok) {
    return ended;
  }

  const failureSnapshot: RunFailureSnapshot = {
    message: event.error,
    ...(event.code === undefined ? {} : { code: event.code }),
  };
  const step = withRun(ended.snapshot, { ...ended.run, failure: failureSnapshot });

  return completeRunMessages(step, event.runId, undefined);
}

function reduceRunCancelled(
  snapshot: ThreadSnapshot,
  event: RunCancelledEvent,
): ReduceRunEventResult {
  const ended = asTerminal(snapshot, event.runId, "cancelled");
  if (!ended.ok) {
    return ended;
  }

  const run: RunSnapshot = {
    ...ended.run,
    ...(event.reason === undefined ? {} : { cancelReason: event.reason }),
  };

  return completeRunMessages(withRun(ended.snapshot, run), event.runId, undefined);
}

function reduceRunSteered(snapshot: ThreadSnapshot, event: RunSteeredEvent): ReduceRunEventResult {
  const running = asRunning(snapshot, event.runId);
  if (!running.ok) {
    return running;
  }

  if (findMessage(running.snapshot, event.messageId) !== undefined) {
    return failure(new MessageConflict(event.messageId, "already_exists"));
  }

  const message: MessageSnapshot = {
    id: event.messageId,
    runId: event.runId,
    role: "user",
    text: event.text,
    complete: true,
  };

  return { ok: true, snapshot: withMessage(running.snapshot, message) };
}

function applyEvent(snapshot: ThreadSnapshot, event: RunEvent): ReduceRunEventResult {
  switch (event.type) {
    case "run.started":
      return reduceRunStarted(snapshot, event);
    case "token.delta":
      return reduceTokenDelta(snapshot, event);
    case "tool.requested":
      return reduceToolRequested(snapshot, event);
    case "tool.completed":
    case "tool.failed":
      return reduceToolResolution(snapshot, event);
    case "run.completed":
      return reduceRunCompleted(snapshot, event);
    case "run.failed":
      return reduceRunFailed(snapshot, event);
    case "run.cancelled":
      return reduceRunCancelled(snapshot, event);
    case "run.steered":
      return reduceRunSteered(snapshot, event);
  }
}

function applyAtCursor(snapshot: ThreadSnapshot, event: RunEvent): ReduceRunEventResult {
  const applied = applyEvent(snapshot, event);
  if (!applied.ok) {
    return applied;
  }

  return {
    ok: true,
    snapshot: {
      ...applied.snapshot,
      lastSeq: event.seq,
      pendingEvents: snapshot.pendingEvents.filter((pending) => pending.seq !== event.seq),
    },
  };
}

function withPending(snapshot: ThreadSnapshot, event: RunEvent): ThreadSnapshot {
  const pendingEvents = [...snapshot.pendingEvents, event].sort(
    (left, right) => left.seq - right.seq,
  );

  return { ...snapshot, pendingEvents };
}

function drainPending(snapshot: ThreadSnapshot): ReduceRunEventResult {
  let current = snapshot;

  for (;;) {
    const next = current.pendingEvents.find((event) => event.seq === current.lastSeq + 1);
    if (next === undefined) {
      return { ok: true, snapshot: current };
    }

    const applied = applyAtCursor(current, next);
    if (!applied.ok) {
      return applied;
    }

    current = applied.snapshot;
  }
}

export function reduceRunEvent(snapshot: ThreadSnapshot, value: unknown): ReduceRunEventResult {
  const parsed = parseRunEvent(value);
  if (!parsed.ok) {
    return failure(parsed.error);
  }

  const event = parsed.event;
  if (event.threadId !== snapshot.threadId) {
    return failure(new ThreadMismatch(snapshot.threadId, event.threadId));
  }

  if (event.seq <= snapshot.lastSeq) {
    return { ok: true, snapshot };
  }

  if (snapshot.pendingEvents.some((pending) => pending.seq === event.seq)) {
    return { ok: true, snapshot };
  }

  if (event.seq > snapshot.lastSeq + 1) {
    return { ok: true, snapshot: withPending(snapshot, event) };
  }

  const applied = applyAtCursor(snapshot, event);
  if (!applied.ok) {
    return applied;
  }

  return drainPending(applied.snapshot);
}

export function reduceRunEvents(
  snapshot: ThreadSnapshot,
  values: readonly unknown[],
): ReduceRunEventResult {
  let current = snapshot;

  for (const value of values) {
    const result = reduceRunEvent(current, value);
    if (!result.ok) {
      return result;
    }

    current = result.snapshot;
  }

  return { ok: true, snapshot: current };
}
