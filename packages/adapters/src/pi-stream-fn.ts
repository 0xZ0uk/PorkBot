import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { isProviderFailure } from "@porkbot/adapter-kit";
import type { ModelConnection, ModelMessage, ModelRuntimeProvider } from "@porkbot/adapter-kit";

/**
 * The bridge from Pi's agent loop onto `ModelRuntimeProvider` (PRD decisions 12
 * and 13).
 *
 * Pi's loop asks a `StreamFn` for one assistant turn and reduces an
 * `AssistantMessageEventStream`; this deployment's model seam is
 * `ModelRuntimeProvider`, which owns the credential resolution, the URL-safety
 * door and the classified failure vocabulary. The bridge is the only place the
 * two vocabularies meet: Pi's `Context` becomes the provider-neutral
 * `ModelMessage[]`, the provider's `ModelStreamEvent`s become the
 * `start`/`text_*`/`toolcall_*`/`done`/`error` protocol Pi reduces, and a
 * classified failure becomes Pi's `error` event rather than a rejected promise,
 * which is what the `StreamFn` contract requires.
 *
 * Two properties are deliberate. The stream is fed in the background, so the
 * function returns synchronously and a provider that fails before its first
 * frame still answers an error stream. And the `partial` helper is copied for
 * every event: Pi's consumers may hold a frame while the next arrives, so the
 * snapshot they hold cannot be rewritten under them.
 *
 * The turn's usage is not reported here: the provider-neutral stream carries no
 * usage yet, so a completed message keeps Pi's zeroed usage, which the
 * translator reads as "not reported" rather than a measured zero.
 */

export interface PiStreamFnOptions {
  /** The run's endpoint, credential name and model, as the connection carries them. */
  readonly connection: ModelConnection;
  readonly model: string;
  /** The run's provider client: the credential store and the egress door live behind it. */
  readonly runtime: ModelRuntimeProvider;
}

/**
 * The `Model` record Pi's loop carries around. This deployment resolves the
 * endpoint per run rather than from a catalog, so the record is a carrier for
 * the model id and the base URL; the bridge reads the connection and the model
 * from the options, never from this record.
 */
export function createPiModel(options: PiStreamFnOptions): Model<Api> {
  return {
    id: options.model,
    name: options.model,
    api: "openai-completions",
    provider: "porkbot",
    baseUrl: options.connection.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

/** A context the provider-neutral seam cannot replay; the run fails loudly. */
export class PiStreamContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiStreamContextError";
  }
}

/**
 * One Pi context as the provider-neutral message list. The system prompt is the
 * first message; a tool result names the call it answers, and an assistant turn
 * replays the calls it requested so the result has a parent the endpoint can
 * match. An image is refused rather than dropped, because a silently missing
 * attachment is worse than a run that says what it cannot carry.
 */
export function toModelMessages(context: Context): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const systemPrompt = context.systemPrompt?.trim() ?? "";

  if (systemPrompt !== "") {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const message of context.messages) {
    switch (message.role) {
      case "user": {
        messages.push({ role: "user", content: userText(message.content) });
        break;
      }
      case "assistant": {
        messages.push(assistantMessage(message));
        break;
      }
      case "toolResult": {
        messages.push({
          role: "tool",
          content: toolResultText(message.content),
          toolCallId: message.toolCallId,
        });
        break;
      }
    }
  }

  return messages;
}

function userText(content: UserMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  const parts: string[] = [];
  let image = false;

  for (const part of content) {
    if (isTextPart(part)) {
      parts.push(part.text);
    } else if (isImagePart(part)) {
      image = true;
    }
  }

  if (image) {
    throw new PiStreamContextError(
      "this model connection carries text only; an image attachment is not supported",
    );
  }

  return parts.join("\n");
}

function assistantMessage(message: Extract<Message, { role: "assistant" }>): ModelMessage {
  const parts: string[] = [];
  const toolCalls: { callId: string; name: string; arguments: unknown }[] = [];

  for (const part of message.content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "toolCall") {
      toolCalls.push({ callId: part.id, name: part.name, arguments: part.arguments });
    }
  }

  return {
    role: "assistant",
    content: parts.join("\n"),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
}

function toolResultText(content: readonly unknown[]): string {
  const parts: string[] = [];

  for (const part of content) {
    if (isTextPart(part)) {
      parts.push(part.text);
    }
  }

  return parts.join("\n");
}

function isTextPart(part: unknown): part is TextContent {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

function isImagePart(part: unknown): boolean {
  return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image";
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

/**
 * The Pi `StreamFn` over one run's provider client. It never throws: a
 * classified provider failure and a malformed context both become an `error`
 * event carrying a message the loop reduces to `run.failed`.
 */
export function createPiStreamFn(options: PiStreamFnOptions): StreamFn {
  return (_model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    void pump(stream, context, streamOptions, options);

    return stream;
  };
}

async function pump(
  stream: AssistantMessageEventStream,
  context: Context,
  streamOptions: SimpleStreamOptions | undefined,
  options: PiStreamFnOptions,
): Promise<void> {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "porkbot",
    model: options.model,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  stream.push({ type: "start", partial: snapshot(message) });

  try {
    const messages = toModelMessages(context);
    let textIndex: number | undefined;

    const closeText = (): void => {
      if (textIndex === undefined) {
        return;
      }

      const block = message.content[textIndex];

      if (block !== undefined && block.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: textIndex,
          content: block.text,
          partial: snapshot(message),
        });
      }

      textIndex = undefined;
    };

    for await (const event of options.runtime.stream({
      connection: options.connection,
      model: options.model,
      messages,
      ...(context.tools === undefined || context.tools.length === 0
        ? {}
        : {
            tools: context.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }),
      ...(streamOptions?.signal === undefined ? {} : { abortSignal: streamOptions.signal }),
    })) {
      switch (event.type) {
        case "text.delta": {
          if (textIndex === undefined) {
            textIndex = message.content.length;
            message.content.push({ type: "text", text: "" });
            stream.push({
              type: "text_start",
              contentIndex: textIndex,
              partial: snapshot(message),
            });
          }

          const block = message.content[textIndex];

          if (block !== undefined && block.type === "text") {
            block.text += event.delta;
          }

          stream.push({
            type: "text_delta",
            contentIndex: textIndex,
            delta: event.delta,
            partial: snapshot(message),
          });
          break;
        }
        case "tool.requested": {
          closeText();
          const index = message.content.length;
          const call: ToolCall = {
            type: "toolCall",
            id: event.callId,
            name: event.name,
            arguments: asArguments(event.arguments),
          };

          message.content.push(call);
          stream.push({ type: "toolcall_start", contentIndex: index, partial: snapshot(message) });
          stream.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall: call,
            partial: snapshot(message),
          });
          break;
        }
        case "tool.delta":
          break;
        case "completed": {
          closeText();
          const reason = finishReason(event.finishReason);
          message.stopReason = reason;
          stream.push({ type: "done", reason, message: snapshot(message) });
          return;
        }
      }
    }

    throw new PiStreamContextError("the model stream ended before completion");
  } catch (cause) {
    const aborted = streamOptions?.signal?.aborted === true;

    message.stopReason = aborted ? "aborted" : "error";
    message.errorMessage = failureText(cause);

    stream.push({
      type: "error",
      reason: aborted ? "aborted" : "error",
      error: snapshot(message),
    });
  }
}

function finishReason(reason: "stop" | "tool_calls" | "length"): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "toolUse";
    case "length":
      return "length";
  }
}

/** The sentence a failed turn carries; a classified kind leads, detail follows. */
function failureText(cause: unknown): string {
  if (isProviderFailure(cause)) {
    return cause.detail === undefined
      ? `the model endpoint refused the turn (${cause.kind})`
      : `the model endpoint refused the turn (${cause.kind}): ${cause.detail}`;
  }

  if (cause instanceof Error && cause.message.trim() !== "") {
    return cause.message;
  }

  return "the model turn failed";
}

function asArguments(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

/** A stable frame: the content array and its blocks are copied, never shared. */
function snapshot(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "toolCall" ? { ...part, arguments: { ...part.arguments } } : { ...part },
    ),
  };
}

/** Every frame this bridge can emit, for the suites that assert the protocol. */
export type PiStreamFrame = AssistantMessageEvent;
