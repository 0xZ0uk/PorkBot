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
import type { SafeFetch } from "@porkbot/effect";
import { ModelProviderError } from "./model-errors.ts";
import { createOpenAiWire, modelProbeHeader } from "./openai-compatible.ts";
import type { OpenAiWire } from "./openai-compatible.ts";

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
  /**
   * Whether the endpoint answers a streaming request with SSE. Defaults to
   * `true`; `false` is the OpenAI-compatible server that ignores `stream` and
   * returns one JSON completion, which is what makes "streaming unsupported"
   * a probe result rather than a stored hope.
   */
  readonly streaming?: boolean;
  /**
   * When set, every request must carry `Authorization: Bearer <apiKey>` or the
   * endpoint answers the OpenAI-shaped 401. Unset, the emulator checks nothing,
   * so tests that only exercise the wire need no key.
   */
  readonly apiKey?: string;
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
    ...(message.toolCalls === undefined
      ? {}
      : { toolCalls: message.toolCalls.map((call) => structuredClone(call)) }),
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

function parseToolCalls(value: unknown): ModelMessage["toolCalls"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const calls: { callId: string; name: string; arguments: unknown }[] = [];

  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate["id"] !== "string" ||
      candidate["type"] !== "function" ||
      !isRecord(candidate["function"]) ||
      typeof candidate["function"]["name"] !== "string" ||
      typeof candidate["function"]["arguments"] !== "string"
    ) {
      return undefined;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(candidate["function"]["arguments"]) as unknown;
    } catch {
      return undefined;
    }

    calls.push({ callId: candidate["id"], name: candidate["function"]["name"], arguments: parsed });
  }

  return calls;
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

    const toolCalls = parseToolCalls(candidate["tool_calls"]);

    if (candidate["tool_calls"] !== undefined && toolCalls === undefined) {
      return undefined;
    }

    messages.push({
      role,
      content,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
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

/**
 * A deterministic OpenAI-compatible loopback endpoint and its provider client.
 * The client is the shipped wire client — the same one the real adapter uses —
 * pointed at the emulator through HTTP, so it parses the same SSE frames a
 * hosted endpoint produces and cannot drift from what ships. The scripted key,
 * when one is set, is answered by the emulator's own credential closure; it
 * never dials a host other than the loopback server it owns.
 */
export class ModelEmulator implements ModelRuntimeProvider {
  readonly #server: Server;
  readonly #script: ModelEmulatorScript;
  readonly #wire: OpenAiWire;
  readonly #gates = new Map<string, GateState>();
  readonly #requests: RecordedModelRequest[] = [];
  #baseUrl = "";
  #nextTurn = 0;
  #activeTurn = false;

  private constructor(server: Server, script: ModelEmulatorScript, transport: SafeFetch) {
    this.#server = server;
    this.#script = copyScript(script);
    this.#wire = createOpenAiWire({
      dial: transport,
      credential: async () => this.#script.apiKey ?? "offline",
    });

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

  static async start(script: ModelEmulatorScript, transport: SafeFetch): Promise<ModelEmulator> {
    const server = createServer((request, response) => {
      void emulator.handle(request, response).catch(() => {
        if (!response.headersSent) {
          openAiError(response, 500, "server_error", "emulator_failure");
          return;
        }

        response.destroy();
      });
    });
    const emulator = new ModelEmulator(server, script, transport);

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
    return this.#wire.probe(connection);
  }

  async *stream(request: ModelTurnRequest): AsyncIterable<ModelStreamEvent> {
    this.assertConnection(request.connection);
    yield* this.#wire.stream(request);
  }

  private assertConnection(connection: ModelConnection): void {
    if (connection.baseUrl !== this.#baseUrl) {
      throw new ModelProviderError(
        "not_found",
        "the emulator only serves its own loopback endpoint",
      );
    }
  }

  /**
   * The probe's streaming verification: an endpoint that streams answers with
   * SSE headers, and one that ignores `stream` answers a single JSON
   * completion. Neither path consumes a scripted turn or is recorded, so a
   * probe is a real wire check rather than a script step.
   */
  private serveProbe(request: IncomingMessage, response: ServerResponse): void {
    request.resume();

    if (this.#script.streaming === false) {
      json(response, 200, {
        id: "chatcmpl-probe",
        object: "chat.completion",
        created: 0,
        model: this.#script.models?.[0] ?? defaultModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "" },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write("data: [DONE]\n\n");
    response.end();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let ownsActiveTurn = false;

    try {
      const url = new URL(request.url ?? "/", this.#baseUrl);
      const expectedKey = this.#script.apiKey;

      if (expectedKey !== undefined && request.headers.authorization !== `Bearer ${expectedKey}`) {
        openAiError(response, 401, "authentication_error", "invalid_api_key");
        return;
      }

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

      // The probe's streaming check is answered before the scripted turn
      // machine: it reports what the endpoint does, not what the script says,
      // and it must not consume the next scripted turn.
      if (request.headers[modelProbeHeader] !== undefined) {
        this.serveProbe(request, response);
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
