import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { colors } from "@porkbot/tokens";
import type {
  Bot,
  Message,
  Thread,
  ThreadEventsCallOptions,
  ThreadEventsProcedure,
} from "@porkbot/contracts";
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
}

export function scriptedThreadTransport(
  options: ScriptedThreadTransportOptions = {},
): ConsoleTransport & { readonly transcriptCalls: string[] } {
  const transcriptCalls: string[] = [];
  const notExercised = (): never => {
    throw new Error("not exercised by this test");
  };

  return {
    transcriptCalls,

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
