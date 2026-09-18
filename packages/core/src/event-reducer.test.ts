import { describe, expect, it } from "vitest";
import {
  IllegalEventTransition,
  MessageConflict,
  ToolCallConflict,
  ThreadMismatch,
  UnknownToolCall,
  createThreadSnapshot,
  reduceRunEvent,
  reduceRunEvents,
} from "./event-reducer.ts";
import { RUN_EVENT_SCHEMA_VERSION, UnknownEventType, UnknownSchemaVersion } from "./run-events.ts";
import type {
  RunCancelledEvent,
  RunCompletedEvent,
  RunEventError,
  RunFailedEvent,
  RunStartedEvent,
  RunSteeredEvent,
  TokenDeltaEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolRequestedEvent,
} from "./run-events.ts";
import type { ThreadSnapshot } from "./event-reducer.ts";

const threadId = "thread-1";
const runId = "run-1";
const otherRunId = "run-2";

function base(seq: number, run = runId) {
  return { schemaVersion: RUN_EVENT_SCHEMA_VERSION, seq, threadId, runId: run } as const;
}

function started(seq: number, run = runId): RunStartedEvent {
  return { ...base(seq, run), type: "run.started" };
}

function token(seq: number, messageId: string, delta: string, run = runId): TokenDeltaEvent {
  return { ...base(seq, run), type: "token.delta", messageId, delta };
}

function toolRequested(
  seq: number,
  callId: string,
  tool: string,
  callArguments: unknown,
  run = runId,
): ToolRequestedEvent {
  return { ...base(seq, run), type: "tool.requested", callId, tool, arguments: callArguments };
}

function toolCompleted(
  seq: number,
  callId: string,
  result: unknown,
  run = runId,
): ToolCompletedEvent {
  return { ...base(seq, run), type: "tool.completed", callId, result };
}

function toolFailed(seq: number, callId: string, error: string, run = runId): ToolFailedEvent {
  return { ...base(seq, run), type: "tool.failed", callId, error };
}

function completed(seq: number, messageId?: string, run = runId): RunCompletedEvent {
  return {
    ...base(seq, run),
    type: "run.completed",
    ...(messageId === undefined ? {} : { messageId }),
  };
}

function failed(seq: number, error: string, code?: string, run = runId): RunFailedEvent {
  return {
    ...base(seq, run),
    type: "run.failed",
    error,
    ...(code === undefined ? {} : { code }),
  };
}

function cancelled(seq: number, reason?: string, run = runId): RunCancelledEvent {
  return {
    ...base(seq, run),
    type: "run.cancelled",
    ...(reason === undefined ? {} : { reason }),
  };
}

function steered(seq: number, messageId: string, text: string, run = runId): RunSteeredEvent {
  return { ...base(seq, run), type: "run.steered", messageId, text };
}

function reduceAll(snapshot: ThreadSnapshot, events: readonly unknown[]): ThreadSnapshot {
  const result = reduceRunEvents(snapshot, events);
  if (!result.ok) {
    throw result.error;
  }

  return result.snapshot;
}

function expectFailure(snapshot: ThreadSnapshot, event: unknown): RunEventError {
  const result = reduceRunEvent(snapshot, event);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected the reducer to reject the event");
  }

  return result.error;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [Array.from(items)];
  }

  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }

    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const permutation of permutations(rest)) {
      result.push([item, ...permutation]);
    }
  }

  return result;
}

describe("createThreadSnapshot", () => {
  it("starts empty and expects the thread's first event at seq 1", () => {
    const snapshot = createThreadSnapshot(threadId);
    expect(snapshot).toEqual({
      threadId,
      runs: [],
      messages: [],
      lastSeq: 0,
      pendingEvents: [],
    });
  });

  it("resumes from a supplied cursor", () => {
    const snapshot = createThreadSnapshot(threadId, { lastSeq: 2 });

    const replayed = reduceAll(snapshot, [token(2, "m", "old")]);
    expect(replayed).toBe(snapshot);

    const applied = reduceAll(snapshot, [token(3, "m", "new")]);
    expect(applied.lastSeq).toBe(3);
    expect(applied.messages).toEqual([
      { id: "m", runId, role: "assistant", text: "new", complete: false },
    ]);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid cursor: %s",
    (lastSeq) => {
      expect(() => createThreadSnapshot(threadId, { lastSeq })).toThrow(RangeError);
    },
  );
});

describe("token deltas", () => {
  it("streams into one assistant message and completes", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      token(1, "msg-1", "Hel"),
      token(2, "msg-1", "lo"),
      completed(3, "msg-1"),
    ]);

    expect(snapshot).toEqual({
      threadId,
      lastSeq: 3,
      pendingEvents: [],
      runs: [{ runId, status: "completed", toolCalls: [] }],
      messages: [{ id: "msg-1", runId, role: "assistant", text: "Hello", complete: true }],
    });
  });

  it("keeps separate messages of a run separate", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      token(1, "msg-1", "thinking"),
      toolRequested(2, "call-1", "shell", { command: "ls" }),
      toolCompleted(3, "call-1", { exitCode: 0 }),
      token(4, "msg-2", "done"),
      completed(5, "msg-2"),
    ]);

    expect(
      snapshot.messages.map((message) => [message.id, message.text, message.complete]),
    ).toEqual([
      ["msg-1", "thinking", true],
      ["msg-2", "done", true],
    ]);
  });

  it("folds concurrent runs of one thread independently", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      token(1, "msg-1", "a", runId),
      token(2, "msg-2", "b", otherRunId),
      completed(3, "msg-1", runId),
      token(4, "msg-2", "c", otherRunId),
    ]);

    expect(snapshot.runs.map((run) => [run.runId, run.status])).toEqual([
      [runId, "completed"],
      [otherRunId, "running"],
    ]);
    expect(
      snapshot.messages.map((message) => [message.id, message.text, message.complete]),
    ).toEqual([
      ["msg-1", "a", true],
      ["msg-2", "bc", false],
    ]);
  });
});

describe("tool calls", () => {
  it("folds a requested tool call into a completed one", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      token(1, "msg-1", "working"),
      toolRequested(2, "call-1", "shell", { command: "echo hi" }),
      toolCompleted(3, "call-1", { stdout: "hi\n" }),
      completed(4, "msg-1"),
    ]);

    expect(snapshot.runs).toEqual([
      {
        runId,
        status: "completed",
        toolCalls: [
          {
            callId: "call-1",
            tool: "shell",
            arguments: { command: "echo hi" },
            status: "completed",
            result: { stdout: "hi\n" },
          },
        ],
      },
    ]);
  });

  it("folds a requested tool call into a failed one", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      toolRequested(1, "call-1", "shell", { command: "exit 1" }),
      toolFailed(2, "call-1", "exit code 1"),
      completed(3, undefined),
    ]);

    expect(snapshot.runs[0]?.toolCalls).toEqual([
      {
        callId: "call-1",
        tool: "shell",
        arguments: { command: "exit 1" },
        status: "failed",
        error: "exit code 1",
      },
    ]);
  });

  it("rejects a result for a call that was never requested", () => {
    const snapshot = createThreadSnapshot(threadId);
    expect(expectFailure(snapshot, toolCompleted(1, "call-1", {}))).toBeInstanceOf(UnknownToolCall);

    const withRun = reduceAll(snapshot, [token(1, "msg-1", "hi")]);
    const error = expectFailure(withRun, toolFailed(2, "call-1", "boom"));
    expect(error).toBeInstanceOf(UnknownToolCall);
    if (error instanceof UnknownToolCall) {
      expect(error.callId).toBe("call-1");
    }
  });

  it("rejects a result addressed to another run", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      toolRequested(1, "call-1", "shell", {}),
    ]);

    expect(expectFailure(snapshot, toolCompleted(2, "call-1", {}, otherRunId))).toBeInstanceOf(
      UnknownToolCall,
    );
  });

  it("rejects a second request for the same call", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      toolRequested(1, "call-1", "shell", {}),
    ]);

    const error = expectFailure(snapshot, toolRequested(2, "call-1", "shell", {}));
    expect(error).toBeInstanceOf(ToolCallConflict);
    if (error instanceof ToolCallConflict) {
      expect(error.callId).toBe("call-1");
      expect(error.reason).toBe("duplicate_request");
    }
  });

  it("rejects a second resolution of the same call", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      toolRequested(1, "call-1", "shell", {}),
      toolCompleted(2, "call-1", { exitCode: 0 }),
    ]);

    const error = expectFailure(snapshot, toolFailed(3, "call-1", "boom"));
    expect(error).toBeInstanceOf(ToolCallConflict);
    if (error instanceof ToolCallConflict) {
      expect(error.reason).toBe("already_resolved");
    }
  });
});

describe("run terminal events", () => {
  it("fails a run, keeps the partial text and records the failure", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      token(1, "msg-1", "partial"),
      failed(2, "provider exploded", "model_error"),
    ]);

    expect(snapshot.runs).toEqual([
      {
        runId,
        status: "failed",
        toolCalls: [],
        failure: { message: "provider exploded", code: "model_error" },
      },
    ]);
    expect(snapshot.messages).toEqual([
      { id: "msg-1", runId, role: "assistant", text: "partial", complete: true },
    ]);
  });

  it("omits the failure code when the event carried none", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [failed(1, "boom")]);
    const run = snapshot.runs[0];
    expect(run?.status).toBe("failed");
    if (run?.failure === undefined) {
      throw new Error("expected the run to carry a failure");
    }

    expect("code" in run.failure).toBe(false);
  });

  it("cancels a queued run and records the reason", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [cancelled(1, "operator")]);
    expect(snapshot.runs).toEqual([
      { runId, status: "cancelled", toolCalls: [], cancelReason: "operator" },
    ]);
  });

  it("cancels without inventing a reason", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [cancelled(1)]);
    const run = snapshot.runs[0];
    expect(run?.status).toBe("cancelled");
    if (run === undefined) {
      throw new Error("expected the run to exist");
    }

    expect("cancelReason" in run).toBe(false);
  });

  it("completes a run that streamed nothing", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [started(1), completed(2)]);
    expect(snapshot.runs).toEqual([{ runId, status: "completed", toolCalls: [] }]);
    expect(snapshot.messages).toEqual([]);
  });

  it("creates the named message when a completion arrives without its tokens", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [started(1), completed(2, "msg-1")]);
    expect(snapshot.messages).toEqual([
      { id: "msg-1", runId, role: "assistant", text: "", complete: true },
    ]);
  });

  it("rejects a completion for a run that never started", () => {
    const snapshot = createThreadSnapshot(threadId);
    const error = expectFailure(snapshot, completed(1, "msg-1"));
    expect(error).toBeInstanceOf(IllegalEventTransition);
    if (error instanceof IllegalEventTransition) {
      expect(error.from).toBe("queued");
      expect(error.to).toBe("completed");
    }
  });

  it("marks a run running on its start event and rejects a second start", () => {
    const running = reduceAll(createThreadSnapshot(threadId), [started(1)]);
    expect(running.runs).toEqual([{ runId, status: "running", toolCalls: [] }]);

    expect(expectFailure(running, started(2))).toBeInstanceOf(IllegalEventTransition);
  });

  it("rejects a token after the run failed", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      token(1, "msg-1", "partial"),
      failed(2, "boom"),
    ]);

    const error = expectFailure(snapshot, token(3, "msg-1", "more"));
    expect(error).toBeInstanceOf(IllegalEventTransition);
    if (error instanceof IllegalEventTransition) {
      expect(error.from).toBe("failed");
      expect(error.to).toBe("running");
      expect(error.message).toBe("Illegal run transition: failed -> running");
    }
  });

  it("rejects a second completion", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [started(1), completed(2, "msg-1")]);
    expect(expectFailure(snapshot, completed(3, "msg-1"))).toBeInstanceOf(IllegalEventTransition);
  });

  it("rejects a completion that names a user message", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [steered(1, "msg-1", "hello")]);
    const error = expectFailure(snapshot, completed(2, "msg-1"));
    expect(error).toBeInstanceOf(MessageConflict);
    if (error instanceof MessageConflict) {
      expect(error.messageId).toBe("msg-1");
      expect(error.reason).toBe("not_assistant");
    }
  });
});

describe("steering", () => {
  it("appends a user message and keeps the run live", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      token(1, "assistant-1", "working"),
      steered(2, "user-1", "stop that"),
      token(3, "assistant-1", "!"),
      completed(4, "assistant-1"),
    ]);

    expect(snapshot.messages).toEqual([
      { id: "assistant-1", runId, role: "assistant", text: "working!", complete: true },
      { id: "user-1", runId, role: "user", text: "stop that", complete: true },
    ]);
    expect(snapshot.runs[0]?.status).toBe("completed");
  });

  it("starts a run when steering is its first event", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [steered(1, "user-1", "hello")]);
    expect(snapshot.runs).toEqual([{ runId, status: "running", toolCalls: [] }]);
  });

  it("rejects steering a completed run", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [started(1), completed(2)]);
    expect(expectFailure(snapshot, steered(3, "user-1", "hello"))).toBeInstanceOf(
      IllegalEventTransition,
    );
  });

  it("rejects steering under an existing message id", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [token(1, "msg-1", "hi")]);
    const error = expectFailure(snapshot, steered(2, "msg-1", "hello"));
    expect(error).toBeInstanceOf(MessageConflict);
    if (error instanceof MessageConflict) {
      expect(error.reason).toBe("already_exists");
    }
  });

  it("rejects a token delta that targets a user message", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [steered(1, "msg-1", "hello")]);
    const error = expectFailure(snapshot, token(2, "msg-1", "world"));
    expect(error).toBeInstanceOf(MessageConflict);
    if (error instanceof MessageConflict) {
      expect(error.reason).toBe("not_assistant");
    }
  });
});

describe("ordering and replay", () => {
  const conversation = [
    started(1),
    token(2, "msg-1", "Hello"),
    token(3, "msg-1", " world"),
    toolRequested(4, "call-1", "echo", { text: "hi" }),
    toolCompleted(5, "call-1", { echoed: "hi" }),
    steered(6, "msg-2", "one more thing"),
    completed(7, "msg-1"),
  ];

  it("buffers an event that arrives before its predecessor", () => {
    const start = createThreadSnapshot(threadId);
    const early = reduceRunEvent(start, token(2, "m", "b"));
    expect(early.ok).toBe(true);
    if (!early.ok) {
      return;
    }

    expect(early.snapshot.lastSeq).toBe(0);
    expect(early.snapshot.pendingEvents).toEqual([token(2, "m", "b")]);
    expect(early.snapshot.messages).toEqual([]);

    const filled = reduceRunEvent(early.snapshot, token(1, "m", "a"));
    expect(filled.ok).toBe(true);
    if (!filled.ok) {
      return;
    }

    expect(filled.snapshot.lastSeq).toBe(2);
    expect(filled.snapshot.pendingEvents).toEqual([]);
    expect(filled.snapshot.messages).toEqual([
      { id: "m", runId, role: "assistant", text: "ab", complete: false },
    ]);
  });

  it("keeps buffered events ordered by seq", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [
      token(4, "m", "d"),
      token(2, "m", "b"),
      token(3, "m", "c"),
    ]);

    expect(snapshot.pendingEvents.map((event) => event.seq)).toEqual([2, 3, 4]);
  });

  it("ignores a replay of an applied event", () => {
    const applied = reduceAll(createThreadSnapshot(threadId), conversation);
    const replayed = reduceAll(applied, conversation);
    expect(replayed).toBe(applied);
  });

  it("ignores a second copy of a buffered event", () => {
    const buffered = reduceAll(createThreadSnapshot(threadId), [token(3, "m", "c")]);
    expect(reduceAll(buffered, [token(3, "m", "c")])).toBe(buffered);
  });

  it("produces the same snapshot for every arrival order", () => {
    const expected = reduceAll(createThreadSnapshot(threadId), conversation);

    for (const arrival of permutations(conversation)) {
      expect(reduceAll(createThreadSnapshot(threadId), arrival)).toEqual(expected);
    }
  });

  it("survives a shuffled replay of a prefix", () => {
    const expected = reduceAll(createThreadSnapshot(threadId), conversation);
    const replay = [
      ...conversation.slice(2),
      ...conversation.slice(0, 2),
      ...conversation.slice(1, 4),
      ...conversation.slice(4),
    ];

    expect(reduceAll(createThreadSnapshot(threadId), replay)).toEqual(expected);
  });

  it("stops at the first rejected event", () => {
    const result = reduceRunEvents(createThreadSnapshot(threadId), [
      token(1, "m", "a"),
      { ...base(2), type: "nope" },
      token(3, "m", "c"),
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnknownEventType);
    }
  });
});

describe("rejected input", () => {
  it("rejects an event for another thread and leaves the snapshot alone", () => {
    const snapshot = reduceAll(createThreadSnapshot(threadId), [token(1, "m", "a")]);
    const foreign = {
      ...token(99, "m", "b"),
      threadId: "thread-2",
    };

    const error = expectFailure(snapshot, foreign);
    expect(error).toBeInstanceOf(ThreadMismatch);
    if (error instanceof ThreadMismatch) {
      expect(error.expectedThreadId).toBe(threadId);
      expect(error.receivedThreadId).toBe("thread-2");
    }
  });

  it("reports unknown event types and schema versions as typed errors", () => {
    const snapshot = createThreadSnapshot(threadId);
    expect(expectFailure(snapshot, { ...base(1), type: "run.approved" })).toBeInstanceOf(
      UnknownEventType,
    );
    expect(
      expectFailure(snapshot, { ...base(1), schemaVersion: 2, type: "run.completed" }),
    ).toBeInstanceOf(UnknownSchemaVersion);

    expect(snapshot.lastSeq).toBe(0);
    expect(snapshot.pendingEvents).toEqual([]);
  });

  it("does not advance the cursor when an event fails", () => {
    const snapshot = createThreadSnapshot(threadId);
    expect(expectFailure(snapshot, toolCompleted(1, "call-1", {}))).toBeInstanceOf(UnknownToolCall);

    const applied = reduceAll(snapshot, [token(1, "m", "ok")]);
    expect(applied.lastSeq).toBe(1);
  });

  it("accepts events straight from JSON", () => {
    const wire = JSON.stringify([
      {
        schemaVersion: RUN_EVENT_SCHEMA_VERSION,
        seq: 1,
        threadId,
        runId,
        type: "token.delta",
        messageId: "m",
        delta: "hi",
      },
      {
        schemaVersion: RUN_EVENT_SCHEMA_VERSION,
        seq: 2,
        threadId,
        runId,
        type: "run.completed",
        messageId: "m",
      },
    ]);

    const events: unknown = JSON.parse(wire);
    const snapshot = reduceAll(createThreadSnapshot(threadId), events as unknown[]);
    expect(snapshot.messages).toEqual([
      { id: "m", runId, role: "assistant", text: "hi", complete: true },
    ]);
  });
});

describe("purity", () => {
  it("never mutates the snapshot it is given", () => {
    const before = reduceAll(createThreadSnapshot(threadId), [token(1, "m", "a")]);
    const copy = structuredClone(before);
    deepFreeze(before);

    const after = reduceAll(before, [token(2, "m", "b")]);

    expect(after).not.toBe(before);
    expect(before).toEqual(copy);
    expect(after.messages).toEqual([
      { id: "m", runId, role: "assistant", text: "ab", complete: false },
    ]);
  });

  it("produces an equal snapshot from an equal event list", () => {
    const events = [
      token(1, "m", "a"),
      toolRequested(2, "call-1", "echo", { text: "a" }),
      toolCompleted(3, "call-1", { echo: "a" }),
      completed(4, "m"),
    ];

    expect(reduceAll(createThreadSnapshot(threadId), events)).toEqual(
      reduceAll(createThreadSnapshot(threadId), events),
    );
  });
});
