import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, TextContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import type {
  ModelConnection,
  ModelMessage,
  ModelRuntimeProvider,
  ModelToolDefinition,
} from "@porkbot/adapter-kit";
import { piAgentRuntimeLayer } from "./pi-run-source.ts";
import type { PiRunSource } from "./pi-run-source.ts";
import type { AgentRuntimeLayer, UsageRecorder } from "@porkbot/effect";
import { createPiModel, createPiStreamFn } from "./pi-stream-fn.ts";

/**
 * The live Pi source: a real agent loop behind the shipped `PiRunSource` seam
 * (PRD decision 13).
 *
 * `piAgentRuntimeLayer` consumes an async iterator of canonical Pi events and a
 * control surface; the offline source replays a recorded corpus. This module is
 * the other side of that seam: it builds the `Agent`, starts the operator's
 * prompt, and exposes the loop's own events and controls — so the adapter, the
 * translator and the durable run event stream are exercised by a live run
 * exactly as they are by a replay.
 *
 * The loop's vendor types never leave this package: the worker asks for an
 * `AgentRuntimeLayer` and hands in provider-neutral values. The `Agent` owns
 * the transcript, the tool execution and the turn lifecycle; steering injects
 * an operator message at the loop's next drain point, stopping aborts the
 * active run, and the loop reports the abort as the terminal event the
 * translator maps to `run.cancelled`.
 *
 * The assistant message's usage is not bridged yet — the provider-neutral
 * stream carries no usage — so `message_end` reports "not reported" rather than
 * a zero. History is replayed at the `Message` level, including completed tool
 * calls and their results, so a later turn sees the same conversation the
 * endpoint was sent.
 */

/** One tool the loop may execute, as the worker wires it. */
export interface LiveTool {
  readonly definition: ModelToolDefinition;
  /**
   * Executes one call. A rejection is the call's failure: the loop reports it
   * as an error result the model reads, and a resolved value is the call's
   * result, serialized into the tool-result content.
   */
  readonly execute: (call: {
    readonly callId: string;
    readonly tool: string;
    readonly arguments: unknown;
  }) => Promise<unknown>;
}

export interface PiAgentSourceOptions {
  readonly streamFn: StreamFn;
  readonly model: Model<Api>;
  readonly systemPrompt: string;
  /** The conversation before the operator's new message, oldest first. */
  readonly history: readonly ModelMessage[];
  /** The operator's message this run answers. */
  readonly prompt: string;
  readonly tools?: readonly LiveTool[] | undefined;
  /** Forwarded to the provider for cache-aware endpoints. */
  readonly sessionId?: string | undefined;
  /** Wall clock for message timestamps; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/** The startup could not be expressed to the agent loop; the run must fail. */
export class PiAgentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiAgentSourceError";
  }
}

/**
 * One live agent loop as the adapter's `PiRunSource`. The loop starts with this
 * call: events are queued until the session reads them, so no frame is lost
 * between construction and subscription.
 */
export function createPiAgentSource(options: PiAgentSourceOptions): PiRunSource {
  const now = options.now ?? Date.now;
  const agent = new Agent({
    streamFn: options.streamFn,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      messages: toPiMessages(options.history, options.model, now),
      ...(options.tools === undefined
        ? {}
        : { tools: options.tools.map((tool) => toAgentTool(tool)) }),
    },
  });
  // Closing the source is the cancellation channel: the session closes it when
  // the fence is lost or the scope ends, and the loop must stop its in-flight
  // work instead of finishing a call whose result nobody owns.
  const queue = createEventQueue(() => {
    agent.abort();
  });

  agent.subscribe((event: AgentEvent) => {
    queue.push(event);

    if (event.type === "agent_end") {
      queue.end();
    }
  });

  // The prompt runs in the background; the queue carries everything the session
  // reads. The queue ends either way: a rejection is a loop failure the session
  // treats as a defect, and a prompt that settled without its terminal event
  // ends the source rather than leaving the session waiting forever.
  void agent
    .prompt({ role: "user", content: options.prompt, timestamp: now() })
    .catch(() => undefined)
    .finally(() => {
      queue.end();
    });

  return {
    events: queue.iterable,
    controls: {
      steer: (text) => {
        agent.steer({ role: "user", content: text, timestamp: now() });
      },
      stop: () => {
        agent.abort();
      },
      // Approvals are durable state, not a live socket: the tool's own gate
      // polls the approval row the operator decides in another process, so the
      // command path has nothing local to resolve.
      decide: () => undefined,
    },
  };
}

export interface LiveAgentRuntimeOptions {
  /** The run's provider client; the credential store and egress door live behind it. */
  readonly runtime: ModelRuntimeProvider;
  readonly connection: ModelConnection;
  readonly model: string;
  readonly runId: string;
  readonly threadId: string;
  readonly startSeq: number;
  readonly systemPrompt: string;
  /** The conversation before the operator's new message, oldest first. */
  readonly history: readonly ModelMessage[];
  /** The operator's message this run answers. */
  readonly prompt: string;
  readonly tools?: readonly LiveTool[] | undefined;
  readonly usage?: UsageRecorder | undefined;
  /** Wall clock for message timestamps; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/**
 * The assembled live runtime: one call the worker makes with provider-neutral
 * values, and the run-scoped `AgentRuntimeLayer` the orchestrator provides
 * beside the run's repositories.
 */
export function createLiveAgentRuntimeLayer(options: LiveAgentRuntimeOptions): AgentRuntimeLayer {
  const bridge = {
    runtime: options.runtime,
    connection: options.connection,
    model: options.model,
  } as const;
  const source = createPiAgentSource({
    streamFn: createPiStreamFn(bridge),
    model: createPiModel(bridge),
    systemPrompt: options.systemPrompt,
    history: options.history,
    prompt: options.prompt,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return piAgentRuntimeLayer(
    {
      runId: options.runId,
      threadId: options.threadId,
      startSeq: options.startSeq,
      connection: options.connection,
      model: options.model,
      systemPrompt: options.systemPrompt,
      messages: options.history,
    },
    source,
    options.usage === undefined ? {} : { usage: options.usage },
  );
}

function toAgentTool(tool: LiveTool): AgentTool {
  return {
    name: tool.definition.name,
    label: tool.definition.name,
    description: tool.definition.description,
    parameters: tool.definition.parameters as AgentTool["parameters"],
    execute: async (toolCallId, params) => {
      const result = await tool.execute({
        callId: toolCallId,
        tool: tool.definition.name,
        arguments: params,
      });

      return {
        content: [{ type: "text", text: serializeResult(result) }],
        details: result,
      };
    },
  };
}

function serializeResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

/**
 * The provider-neutral conversation as Pi messages. A `tool` message needs the
 * name of the call it answers, which the neutral shape names only by id, so the
 * assistant turns are read first and the calls are indexed by id.
 */
function toPiMessages(
  history: readonly ModelMessage[],
  model: Model<Api>,
  now: () => number,
): Message[] {
  const calls = new Map<string, string>();
  const messages: Message[] = [];

  for (const message of history) {
    switch (message.role) {
      case "system":
        continue;
      case "user": {
        messages.push({ role: "user", content: message.content, timestamp: now() });
        break;
      }
      case "assistant": {
        const content: (TextContent | ToolCall)[] = [];

        if (message.content.trim() !== "") {
          content.push({ type: "text", text: message.content });
        }

        for (const call of message.toolCalls ?? []) {
          calls.set(call.callId, call.name);
          content.push({
            type: "toolCall",
            id: call.callId,
            name: call.name,
            arguments: asArguments(call.arguments),
          });
        }

        messages.push({
          role: "assistant",
          content,
          api: "openai-completions",
          provider: "porkbot",
          model: model.id,
          usage: emptyUsage(),
          stopReason: "stop",
          timestamp: now(),
        });
        break;
      }
      case "tool": {
        if (message.toolCallId === undefined) {
          throw new PiAgentSourceError("a tool turn carries no toolCallId to answer");
        }

        messages.push({
          role: "toolResult",
          toolCallId: message.toolCallId,
          toolName: calls.get(message.toolCallId) ?? message.toolCallId,
          content: [{ type: "text", text: message.content }],
          isError: false,
          timestamp: now(),
        });
        break;
      }
    }
  }

  return messages;
}

function asArguments(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** An unbounded, single-consumer event queue; the loop owns the producer side. */
function createEventQueue(onClose: () => void): {
  readonly iterable: AsyncIterable<unknown>;
  push(event: AgentEvent): void;
  end(): void;
} {
  const events: AgentEvent[] = [];
  const waiting: ((result: IteratorResult<AgentEvent>) => void)[] = [];
  let ended = false;

  function flushEnd(): void {
    while (waiting.length > 0) {
      waiting.shift()?.({ done: true, value: undefined });
    }
  }

  return {
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            const event = events.shift();

            if (event !== undefined) {
              return { done: false, value: event };
            }

            if (ended) {
              return { done: true, value: undefined };
            }

            return new Promise<IteratorResult<AgentEvent>>((resolve) => {
              waiting.push(resolve);
            });
          },
          return: (): Promise<IteratorResult<AgentEvent>> => {
            ended = true;
            flushEnd();
            onClose();

            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    },
    push: (event) => {
      if (ended) {
        return;
      }

      const waiter = waiting.shift();

      if (waiter !== undefined) {
        waiter({ done: false, value: event });
        return;
      }

      events.push(event);
    },
    end: () => {
      ended = true;
      flushEnd();
    },
  };
}
