import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type {
  ModelConnection,
  ModelMessage,
  ModelProbeResult,
  ModelRuntimeProvider,
  ModelStreamEvent,
  ModelToolDefinition,
  ModelTurnRequest,
  ProviderFailureKind,
} from "@porkbot/adapter-kit";
import { ModelProviderError } from "./model-errors.ts";

export type ModelEmulatorGateReason = "suspension" | "steering" | "compaction";

export type ModelEmulatorStep =
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      /** Each entry is sent in a separate OpenAI tool-call delta. */
      readonly argumentDeltas: readonly string[];
    }
  | {
      readonly type: "gate";
      readonly name: string;
      /** Documents which lifecycle action the fixture pauses for. */
      readonly reason: ModelEmulatorGateReason;
    };

export interface ModelEmulatorExpectedRequest {
  readonly model?: string;
  readonly messages?: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
}

export interface ModelEmulatorTurn {
  /** A classified OpenAI-shaped refusal. A failed turn has no stream steps. */
  readonly failure?: ProviderFailureKind;
  readonly expect?: ModelEmulatorExpectedRequest;
  readonly steps?: readonly ModelEmulatorStep[];
  readonly finishReason?: "stop" | "tool_calls" | "length";
}

export interface ModelEmulatorScript {
  readonly models?: readonly string[];
  readonly turns: readonly ModelEmulatorTurn[];
}

export interface RecordedModelRequest {
  readonly sequence: number;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface GateState {
  readonly reached: Deferred;
  readonly released: Deferred;
  readonly left: Deferred;
}

interface OpenAiMessage {
  readonly role: ModelMessage["role"];
  readonly content: string;
  readonly tool_call_id?: string;
}

interface OpenAiTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

interface OpenAiRequest {
  readonly model: string;
  readonly messages: readonly OpenAiMessage[];
  readonly tools?: readonly OpenAiTool[];
  readonly stream: true;
}

interface ToolAccumulator {
  callId: string;
  name: string;
  arguments: string;
}

const defaultModel = "porkbot-emulator";
const maximumRequestBytes = 1024 * 1024;

const failureResponses: Readonly<
  Record<
    ProviderFailureKind,
    { readonly status: number; readonly type: string; readonly code: string }
  >
> = {
  gone: { status: 410, type: "invalid_request_error", code: "gone" },
  not_found: { status: 404, type: "invalid_request_error", code: "model_not_found" },
  rate_limited: { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded" },
  timed_out: { status: 504, type: "server_error", code: "timeout" },
  auth_failed: { status: 401, type: "authentication_error", code: "invalid_api_key" },
};

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  };
}

function cloneTool(tool: ModelToolDefinition): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
  };
}

function copyScript(script: ModelEmulatorScript): ModelEmulatorScript {
  return structuredClone(script);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessages(value: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const messages: ModelMessage[] = [];

  for (const candidate of value) {
    if (!isRecord(candidate)) {
      return undefined;
    }

    const role = candidate["role"];
    const content = candidate["content"];

    if (
      (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") ||
      typeof content !== "string"
    ) {
      return undefined;
    }

    const toolCallId = candidate["tool_call_id"];

    if (toolCallId !== undefined && typeof toolCallId !== "string") {
      return undefined;
    }

    messages.push({
      role,
      content,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
  }

  return messages;
}

function parseTools(value: unknown): ModelToolDefinition[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const tools: ModelToolDefinition[] = [];

  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      candidate["type"] !== "function" ||
      !isRecord(candidate["function"])
    ) {
      return undefined;
    }

    const definition = candidate["function"];

    if (typeof definition["name"] !== "string" || typeof definition["description"] !== "string") {
      return undefined;
    }

    tools.push({
      name: definition["name"],
      description: definition["description"],
      parameters: structuredClone(definition["parameters"]),
    });
  }

  return tools;
}

function parseRequest(value: unknown, sequence: number): RecordedModelRequest | undefined {
  if (!isRecord(value) || typeof value["model"] !== "string" || value["stream"] !== true) {
    return undefined;
  }

  const messages = parseMessages(value["messages"]);
  const tools = parseTools(value["tools"]);

  if (messages === undefined || tools === undefined) {
    return undefined;
  }

  return { sequence, model: value["model"], messages, tools };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function openAiError(response: ServerResponse, status: number, type: string, code: string): void {
  json(response, status, {
    error: {
      message: `The scripted model emulator produced ${code}.`,
      type,
      code,
    },
  });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;

    if (size > maximumRequestBytes) {
      throw new Error("request_too_large");
    }

    chunks.push(bytes);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mismatch(turn: ModelEmulatorTurn, request: RecordedModelRequest): string | undefined {
  if (turn.expect?.model !== undefined && turn.expect.model !== request.model) {
    return "model";
  }

  if (turn.expect?.messages !== undefined && !sameValue(turn.expect.messages, request.messages)) {
    return "messages";
  }

  if (turn.expect?.tools !== undefined && !sameValue(turn.expect.tools, request.tools)) {
    return "tools";
  }

  return undefined;
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function waitForReleaseOrClose(gate: GateState, response: ServerResponse): Promise<void> {
  if (response.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      response.off("close", finish);
      resolve();
    };

    response.once("close", finish);
    void gate.released.promise.then(finish);
  });
}

function chunk(
  sequence: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: ModelEmulatorTurn["finishReason"] | null = null,
): unknown {
  return {
    id: `chatcmpl-${sequence}`,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function statusKind(status: number): ProviderFailureKind {
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 410) {
    return "gone";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "timed_out";
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function requestBody(request: ModelTurnRequest): OpenAiRequest {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    })),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
    stream: true,
  };
}

function firstChoice(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value["choices"])) {
    return undefined;
  }

  const choice = value["choices"][0];
  return isRecord(choice) ? choice : undefined;
}

function finishReason(value: unknown): "stop" | "tool_calls" | "length" | undefined {
  return value === "stop" || value === "tool_calls" || value === "length" ? value : undefined;
}

function parseToolDeltas(value: unknown, tools: Map<number, ToolAccumulator>): ModelStreamEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const events: ModelStreamEvent[] = [];

  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate["index"] !== "number") {
      continue;
    }

    const current = tools.get(candidate["index"]) ?? { callId: "", name: "", arguments: "" };

    if (typeof candidate["id"] === "string") {
      current.callId = candidate["id"];
    }

    if (isRecord(candidate["function"])) {
      if (typeof candidate["function"]["name"] === "string") {
        current.name = candidate["function"]["name"];
      }

      if (typeof candidate["function"]["arguments"] === "string") {
        current.arguments += candidate["function"]["arguments"];
        events.push({
          type: "tool.delta",
          callId: current.callId,
          argumentsDelta: candidate["function"]["arguments"],
        });
      }
    }

    tools.set(candidate["index"], current);
  }

  return events;
}

async function* sseData(response: Response): AsyncGenerator<string> {
  if (response.body === null) {
    throw new ModelProviderError(
      "timed_out",
      "the endpoint returned no stream body",
      response.status,
    );
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let dataLines: string[] = [];

  while (true) {
    const read = await reader.read();
    buffer += read.value ?? "";

    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }

      const rawLine = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line === "") {
        if (dataLines.length > 0) {
          yield dataLines.join("\n");
          dataLines = [];
        }
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (read.done) {
      break;
    }
  }

  if (dataLines.length > 0) {
    yield dataLines.join("\n");
  }
}

/**
 * A deterministic OpenAI-compatible loopback endpoint and its provider client.
 * The client reaches the emulator through HTTP and parses the same SSE frames a
 * hosted endpoint produces. It never resolves a credential or dials a host
 * other than the loopback server it owns.
 */
export class ModelEmulator implements ModelRuntimeProvider {
  readonly #server: Server;
  readonly #script: ModelEmulatorScript;
  readonly #gates = new Map<string, GateState>();
  readonly #requests: RecordedModelRequest[] = [];
  #baseUrl = "";
  #nextTurn = 0;
  #activeTurn = false;

  private constructor(server: Server, script: ModelEmulatorScript) {
    this.#server = server;
    this.#script = copyScript(script);

    for (const turn of this.#script.turns) {
      for (const step of turn.steps ?? []) {
        if (step.type !== "gate") {
          continue;
        }

        if (this.#gates.has(step.name)) {
          throw new Error(`Model emulator gate names must be unique: ${step.name}`);
        }

        this.#gates.set(step.name, {
          reached: deferred(),
          released: deferred(),
          left: deferred(),
        });
      }
    }
  }

  static async start(script: ModelEmulatorScript): Promise<ModelEmulator> {
    const server = createServer((request, response) => {
      void emulator.handle(request, response).catch(() => {
        if (!response.headersSent) {
          openAiError(response, 500, "server_error", "emulator_failure");
          return;
        }

        response.destroy();
      });
    });
    const emulator = new ModelEmulator(server, script);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      await emulator.stop();
      throw new Error("the model emulator did not bind a loopback port");
    }

    emulator.#baseUrl = `http://127.0.0.1:${address.port}/v1`;
    return emulator;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get connection(): ModelConnection {
    return { baseUrl: this.#baseUrl, credentialName: "offline-model-emulator" };
  }

  get requests(): readonly RecordedModelRequest[] {
    return this.#requests;
  }

  async stop(): Promise<void> {
    for (const gate of this.#gates.values()) {
      gate.released.resolve();
    }

    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      this.#server.closeAllConnections();
    });
  }

  async waitForGate(name: string): Promise<void> {
    const gate = this.#gates.get(name);

    if (gate === undefined) {
      throw new Error(`Unknown model emulator gate: ${name}`);
    }

    await gate.reached.promise;
  }

  releaseGate(name: string): void {
    const gate = this.#gates.get(name);

    if (gate === undefined) {
      throw new Error(`Unknown model emulator gate: ${name}`);
    }

    gate.released.resolve();
  }

  /** Wait until a released or disconnected stream has moved beyond a gate. */
  async waitForGateExit(name: string): Promise<void> {
    const gate = this.#gates.get(name);

    if (gate === undefined) {
      throw new Error(`Unknown model emulator gate: ${name}`);
    }

    await gate.left.promise;
  }

  async probe(connection: ModelConnection): Promise<ModelProbeResult> {
    this.assertConnection(connection);
    const response = await fetch(endpoint(this.#baseUrl, "models"));

    if (!response.ok) {
      throw new ModelProviderError(
        statusKind(response.status),
        "the model endpoint refused discovery",
        response.status,
      );
    }

    const payload = (await response.json()) as unknown;

    if (!isRecord(payload) || !Array.isArray(payload["data"])) {
      throw new ModelProviderError(
        "timed_out",
        "the model list had an invalid shape",
        response.status,
      );
    }

    const models = payload["data"].flatMap((candidate): { id: string }[] => {
      return isRecord(candidate) && typeof candidate["id"] === "string"
        ? [{ id: candidate["id"] }]
        : [];
    });

    return { reachable: true, models, streaming: true };
  }

  async *stream(request: ModelTurnRequest): AsyncIterable<ModelStreamEvent> {
    this.assertConnection(request.connection);
    let response: Response;

    try {
      response = await fetch(endpoint(this.#baseUrl, "chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody(request)),
        ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
      });
    } catch (cause) {
      throw new ModelProviderError("timed_out", "the loopback stream was interrupted", undefined, {
        cause,
      });
    }

    if (!response.ok) {
      throw new ModelProviderError(
        statusKind(response.status),
        "the model endpoint refused the turn",
        response.status,
      );
    }

    const tools = new Map<number, ToolAccumulator>();
    let completed = false;

    try {
      for await (const data of sseData(response)) {
        if (data === "[DONE]") {
          break;
        }

        let payload: unknown;

        try {
          payload = JSON.parse(data) as unknown;
        } catch (cause) {
          throw new ModelProviderError(
            "timed_out",
            "the endpoint sent invalid SSE JSON",
            undefined,
            { cause },
          );
        }

        const choice = firstChoice(payload);

        if (choice === undefined || !isRecord(choice["delta"])) {
          continue;
        }

        if (typeof choice["delta"]["content"] === "string") {
          yield { type: "text.delta", delta: choice["delta"]["content"] };
        }

        for (const event of parseToolDeltas(choice["delta"]["tool_calls"], tools)) {
          yield event;
        }

        const reason = finishReason(choice["finish_reason"]);

        if (reason !== undefined) {
          for (const [, tool] of [...tools].sort(([left], [right]) => left - right)) {
            yield {
              type: "tool.requested",
              callId: tool.callId,
              name: tool.name,
              arguments: JSON.parse(tool.arguments) as unknown,
            };
          }

          yield { type: "completed", finishReason: reason };
          completed = true;
        }
      }
    } catch (cause) {
      if (cause instanceof ModelProviderError) {
        throw cause;
      }

      throw new ModelProviderError("timed_out", "the model stream was interrupted", undefined, {
        cause,
      });
    }

    if (!completed) {
      throw new ModelProviderError("timed_out", "the model stream ended before completion");
    }
  }

  private assertConnection(connection: ModelConnection): void {
    if (connection.baseUrl !== this.#baseUrl) {
      throw new ModelProviderError(
        "not_found",
        "the emulator only serves its own loopback endpoint",
      );
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let ownsActiveTurn = false;

    try {
      const url = new URL(request.url ?? "/", this.#baseUrl);

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const models = this.#script.models ?? [defaultModel];
        json(response, 200, {
          object: "list",
          data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "porkbot" })),
        });
        return;
      }

      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        openAiError(response, 404, "invalid_request_error", "route_not_found");
        return;
      }

      if (this.#activeTurn) {
        openAiError(response, 409, "invalid_request_error", "concurrent_turn");
        return;
      }

      const turn = this.#script.turns[this.#nextTurn];

      if (turn === undefined) {
        openAiError(response, 410, "invalid_request_error", "script_exhausted");
        return;
      }

      this.#activeTurn = true;
      ownsActiveTurn = true;

      let payload: unknown;

      try {
        payload = await readBody(request);
      } catch {
        openAiError(response, 400, "invalid_request_error", "invalid_json");
        return;
      }

      const sequence = this.#nextTurn + 1;
      const recorded = parseRequest(payload, sequence);

      if (recorded === undefined) {
        openAiError(response, 400, "invalid_request_error", "invalid_request");
        return;
      }

      const differs = mismatch(turn, recorded);

      if (differs !== undefined) {
        openAiError(response, 400, "invalid_request_error", `unexpected_${differs}`);
        return;
      }

      this.#nextTurn += 1;
      this.#requests.push({
        ...recorded,
        messages: recorded.messages.map(cloneMessage),
        tools: recorded.tools.map(cloneTool),
      });

      if (turn.failure !== undefined) {
        const failure = failureResponses[turn.failure];
        openAiError(response, failure.status, failure.type, failure.code);
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      writeSse(response, chunk(sequence, recorded.model, { role: "assistant" }));

      let toolIndex = 0;

      for (const step of turn.steps ?? []) {
        if (step.type === "gate") {
          const gate = this.#gates.get(step.name);
          gate?.reached.resolve();

          if (gate !== undefined) {
            await waitForReleaseOrClose(gate, response);
            gate.left.resolve();
          }

          if (response.destroyed) {
            return;
          }
          continue;
        }

        if (step.type === "text") {
          writeSse(response, chunk(sequence, recorded.model, { content: step.delta }));
          continue;
        }

        for (const [deltaIndex, argumentsDelta] of step.argumentDeltas.entries()) {
          writeSse(
            response,
            chunk(sequence, recorded.model, {
              tool_calls: [
                {
                  index: toolIndex,
                  ...(deltaIndex === 0
                    ? {
                        id: step.callId,
                        type: "function",
                        function: { name: step.name, arguments: argumentsDelta },
                      }
                    : { function: { arguments: argumentsDelta } }),
                },
              ],
            }),
          );
        }
        toolIndex += 1;
      }

      const reason =
        turn.finishReason ??
        ((turn.steps ?? []).some((step) => step.type === "tool_call") ? "tool_calls" : "stop");
      writeSse(response, chunk(sequence, recorded.model, {}, reason));
      response.write("data: [DONE]\n\n");
      response.end();
    } finally {
      if (ownsActiveTurn) {
        this.#activeTurn = false;
      }
    }
  }
}
