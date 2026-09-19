import { ORPCError } from "@porkbot/contracts";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { ApprovalDecision, RunEvent, ToolResultArtifact } from "@porkbot/core";
import { colors } from "@porkbot/tokens";
import type {
  Bot,
  MemoryDocumentView,
  MemoryRevisionView,
  Message,
  RunGet,
  Thread,
  ThreadEventsCallOptions,
  ThreadEventsProcedure,
} from "@porkbot/contracts";
import type { MemoryTransport } from "../src/memory.ts";
import type { ConsoleTransport } from "../src/transport.ts";

/**
 * Test doubles for the thread console, shared by the unit and e2e tiers. The
 * scripted subscription is the important one: it hands the reconnect loop a
 * stream the test controls frame by frame — push an event, end the stream,
 * fail it — so the console's states are driven exactly, and the e2e tier only
 * swaps the procedure for a real HTTP server.
 */

export interface ScriptedEvents {
  readonly procedure: ThreadEventsProcedure;
  /** The options of every call, in order: the resume cursor is observable. */
  readonly calls: ThreadEventsCallOptions[];
  push(event: RunEvent): void;
  /** Ends the open stream cleanly; the client treats it as a drop. */
  end(): void;
  /** Throws inside the open stream; a transport error the client retries. */
  fail(error: unknown): void;
}

interface StreamState {
  readonly queue: RunEvent[];
  wake: (() => void) | undefined;
  outcome:
    { readonly kind: "end" } | { readonly kind: "error"; readonly error: unknown } | undefined;
}

export function createScriptedEvents(): ScriptedEvents {
  const calls: ThreadEventsCallOptions[] = [];
  let current: StreamState | undefined;

  async function* stream(state: StreamState): AsyncGenerator<RunEvent> {
    for (;;) {
      let next = state.queue.shift();

      while (next !== undefined) {
        yield next;
        next = state.queue.shift();
      }

      if (state.outcome?.kind === "error") {
        throw state.outcome.error;
      }

      if (state.outcome?.kind === "end") {
        return;
      }

      await new Promise<void>((resolve) => {
        state.wake = resolve;
      });
    }
  }

  function wake(): void {
    const state = current;

    if (state !== undefined) {
      state.wake?.();
      state.wake = undefined;
    }
  }

  return {
    calls,

    procedure: async (_input, options) => {
      calls.push(options);
      const state: StreamState = { queue: [], wake: undefined, outcome: undefined };
      current = state;

      return stream(state);
    },

    push: (event) => {
      current?.queue.push(event);
      wake();
    },

    end: () => {
      if (current !== undefined) {
        current.outcome = { kind: "end" };
      }

      wake();
    },

    fail: (error) => {
      if (current !== undefined) {
        current.outcome = { kind: "error", error };
      }

      wake();
    },
  };
}

export interface ScriptedThreadTransportOptions {
  readonly transcript?: readonly Message[];
  readonly events?: ThreadEventsProcedure;
  /** Replaces the transcript call outright, for refusal tests. */
  readonly transcriptFailure?: unknown;
  readonly bots?: readonly Bot[];
  readonly threads?: readonly Thread[];
  /** The thread a `createThread` call answers with. */
  readonly newThread?: Thread;
  /**
   * The settled tool results the artifact route resolves, keyed the way the
   * durable ledger keys them: `runId:callId`.
   */
  readonly toolResults?: Readonly<
    Record<string, { readonly tool: string; readonly result: unknown }>
  >;
  /**
   * The liveness reads the console makes, keyed by run id; a miss is the typed
   * NOT_FOUND. A function is read per call, so a test can script a row that
   * disappears between polls.
   */
  readonly runs?: Readonly<Record<string, RunGet>> | (() => Readonly<Record<string, RunGet>>);
}

export function scriptedThreadTransport(
  options: ScriptedThreadTransportOptions = {},
): ConsoleTransport & { readonly transcriptCalls: string[]; readonly runCalls: string[] } {
  const transcriptCalls: string[] = [];
  const runCalls: string[] = [];
  const notExercised = (): never => {
    throw new Error("not exercised by this test");
  };

  return {
    transcriptCalls,
    runCalls,

    async transcript(threadId) {
      transcriptCalls.push(threadId);

      if (options.transcriptFailure !== undefined) {
        throw options.transcriptFailure;
      }

      return options.transcript ?? [];
    },

    events:
      options.events ??
      (async () =>
        (async function* empty(): AsyncGenerator<RunEvent> {
          // A thread with no events: the subscription stays open and silent.
        })()),

    listBots: async () => options.bots ?? [],
    listThreads: async () => options.threads ?? [],
    createThread: async () => options.newThread ?? notExercised(),

    async run(runId) {
      runCalls.push(runId);
      const runs = typeof options.runs === "function" ? options.runs() : options.runs;
      const read = runs?.[runId];

      if (read === undefined) {
        throw new ORPCError("NOT_FOUND", {
          defined: true,
          status: 404,
          message: "no such run",
        });
      }

      return read;
    },

    async toolResult({ runId, callId }) {
      const stored = options.toolResults?.[`${runId}:${callId}`];

      if (stored === undefined) {
        throw new ORPCError("NOT_FOUND", {
          defined: true,
          status: 404,
          message: "no such tool result",
        });
      }

      return stored;
    },
  };
}

export function fakeBot(id: string, name: string): Bot {
  return {
    id,
    name,
    title: "",
    description: "",
    instructions: "",
    color: colors.accent,
    pinned: false,
    position: 0,
    sectionId: null,
    avatarKey: null,
    computerId: null,
    modelConnectionId: null,
    model: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function fakeThread(id: string, botId: string): Thread {
  return {
    id,
    botId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function fakeMemoryDocument(
  overrides: Partial<MemoryDocumentView> = {},
): MemoryDocumentView {
  return {
    documentId: "doc-1",
    kind: "fact",
    title: "Preferred editor",
    content: "The operator prefers keyboard-driven editing.",
    revision: 1,
    deletedAt: null,
    ...overrides,
  };
}

export function fakeMemoryRevision(
  overrides: Partial<MemoryRevisionView> = {},
): MemoryRevisionView {
  return {
    documentId: "doc-1",
    revision: 1,
    origin: "deliberate",
    author: "user-1",
    reason: "operator correction",
    kind: "fact",
    title: "Preferred editor",
    content: "The operator prefers keyboard-driven editing.",
    deleted: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export interface ScriptedMemoryTransportOptions {
  readonly documents?: readonly MemoryDocumentView[];
  readonly revisions?: Readonly<Record<string, readonly MemoryRevisionView[]>>;
}

/**
 * An in-memory memory store for the screen's unit tests: the same decisions
 * the durable store makes, minus Postgres. It is deliberately not the e2e
 * path — that suite crosses a real HTTP server — but it lets a route test
 * drive an edit, a removal and a restore and see the list reload the way the
 * server would have made it.
 */
export function scriptedMemoryTransport(
  options: ScriptedMemoryTransportOptions = {},
): MemoryTransport {
  const documents: MemoryDocumentView[] = [...(options.documents ?? [])];
  const history = new Map<string, MemoryRevisionView[]>(
    Object.entries(options.revisions ?? {}).map(([documentId, revisions]) => [
      documentId,
      [...revisions],
    ]),
  );
  const at = "2026-01-02T00:00:00.000Z";

  function revisionsFor(documentId: string): MemoryRevisionView[] {
    const existing = history.get(documentId);

    if (existing !== undefined) {
      return existing;
    }

    const created: MemoryRevisionView[] = [];
    history.set(documentId, created);
    return created;
  }

  function refusal(documentId: string) {
    return {
      ok: false as const,
      rule: "UnknownMemoryDocument",
      message: `Memory document "${documentId}" does not exist`,
    };
  }

  return {
    list: async (_botId, scope) =>
      documents.filter((document) => (scope === "deleted") === (document.deletedAt !== null)),

    revisions: async (_botId, documentId) => revisionsFor(documentId),

    update: async ({ documentId, title, content, reason }) => {
      const index = documents.findIndex(
        (document) => document.documentId === documentId && document.deletedAt === null,
      );
      const current = documents[index];

      if (index === -1 || current === undefined) {
        return refusal(documentId);
      }

      if (current.title === title && current.content === content) {
        return { ok: true, action: "no_change" };
      }

      const revision = fakeMemoryRevision({
        documentId,
        revision: current.revision + 1,
        reason,
        title,
        content,
        createdAt: at,
      });

      documents[index] = { ...current, title, content, revision: revision.revision };
      revisionsFor(documentId).push(revision);

      return { ok: true, action: "update", revision };
    },

    remove: async ({ documentId, reason }) => {
      const index = documents.findIndex(
        (document) => document.documentId === documentId && document.deletedAt === null,
      );
      const current = documents[index];

      if (index === -1 || current === undefined) {
        return refusal(documentId);
      }

      const revision = fakeMemoryRevision({
        documentId,
        revision: current.revision + 1,
        reason,
        title: current.title,
        content: current.content,
        deleted: true,
        createdAt: at,
      });

      documents[index] = { ...current, revision: revision.revision, deletedAt: at };
      revisionsFor(documentId).push(revision);

      return { ok: true, action: "delete", revision };
    },

    restore: async ({ documentId, revision: number, reason }) => {
      const index = documents.findIndex((document) => document.documentId === documentId);
      const current = documents[index];
      const target = revisionsFor(documentId).find((candidate) => candidate.revision === number);

      if (index === -1 || current === undefined || target === undefined) {
        return {
          ok: false as const,
          rule: "UnknownMemoryRevision",
          message: `Memory document "${documentId}" has no revision ${String(number)}`,
        };
      }

      if (
        current.deletedAt === null &&
        current.title === target.title &&
        current.content === target.content
      ) {
        return { ok: true, action: "no_change" };
      }

      const revision = fakeMemoryRevision({
        documentId,
        revision: current.revision + 1,
        reason,
        kind: target.kind,
        title: target.title,
        content: target.content,
        createdAt: at,
      });

      documents[index] = {
        ...current,
        kind: target.kind,
        title: target.title,
        content: target.content,
        revision: revision.revision,
        deletedAt: null,
      };
      revisionsFor(documentId).push(revision);

      return { ok: true, action: "restore", revision };
    },
  };
}

export function textMessage(input: {
  readonly id: string;
  readonly threadId: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly runId?: string | undefined;
}): Message {
  return {
    id: input.id,
    threadId: input.threadId,
    seq: input.seq,
    role: input.role,
    blocks: [{ type: "text", text: input.text }],
    runId: input.runId ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

export function runStarted(threadId: string, runId: string, seq: number): RunEvent {
  return { schemaVersion: RUN_EVENT_SCHEMA_VERSION, seq, threadId, runId, type: "run.started" };
}

export function tokenDelta(
  threadId: string,
  runId: string,
  seq: number,
  messageId: string,
  delta: string,
): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    type: "token.delta",
    messageId,
    delta,
  };
}

export function runCompleted(
  threadId: string,
  runId: string,
  seq: number,
  messageId: string,
): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    type: "run.completed",
    messageId,
  };
}

export function toolRequested(
  threadId: string,
  runId: string,
  seq: number,
  callId: string,
  tool: string,
  args: unknown,
): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    type: "tool.requested",
    callId,
    tool,
    arguments: args,
  };
}

export function approvalRequested(
  threadId: string,
  runId: string,
  seq: number,
  callId: string,
  expiresAt: string,
): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    type: "approval.requested",
    callId,
    expiresAt,
  };
}

export function approvalResolved(
  threadId: string,
  runId: string,
  seq: number,
  callId: string,
  decision: ApprovalDecision,
  reason?: string,
): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    type: "approval.resolved",
    callId,
    decision,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function toolCompleted(
  threadId: string,
  runId: string,
  seq: number,
  callId: string,
  result: unknown,
  options: { readonly resultArtifact?: ToolResultArtifact; readonly durationMs?: number } = {},
): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    type: "tool.completed",
    callId,
    result,
    ...(options.resultArtifact === undefined ? {} : { resultArtifact: options.resultArtifact }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
  };
}

export function toolFailed(
  threadId: string,
  runId: string,
  seq: number,
  callId: string,
  error: string,
  durationMs?: number,
): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId,
    runId,
    type: "tool.failed",
    callId,
    error,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}
