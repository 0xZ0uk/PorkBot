import type {
  CredentialStore,
  ModelConnection,
  ModelDescriptor,
  ModelProbeResult,
  ModelRuntimeProvider,
  ModelStreamEvent,
  ModelTurnRequest,
  ProviderFailureKind,
} from "@porkbot/adapter-kit";
import { BlockedUrlError, CredentialMissingError, safeFetch } from "@porkbot/effect";
import type { SafeFetch } from "@porkbot/effect";
import { ModelProviderError } from "./model-errors.ts";

/**
 * The one OpenAI-compatible wire client (slice 9.2, PRD decisions 12, 13, 19;
 * stories 12 and 13).
 *
 * Every OpenAI-compatible endpoint — a hosted provider or a self-hosted server
 * by URL and key — is reached through this module: `createOpenAiCompatibleModelRuntime`
 * is the shipped provider, and the offline emulator drives the same client
 * against its loopback server, so the request shape, the SSE parsing and the
 * failure classification cannot drift between what is tested and what ships.
 *
 * The key is never a constructor argument and never an environment read: it is
 * resolved by name from the injected `CredentialStore` on every call, which
 * keeps rotation a store concern and the secret out of adapter configuration.
 * A name the store does not hold fails as the typed `CredentialMissingError`
 * before a byte leaves the process.
 *
 * The endpoint URL is caller-supplied and every request goes through the
 * injected transport, which defaults to the URL-safety module's `safeFetch`, so
 * a shipped deployment only dials an HTTPS endpoint whose resolved address is
 * public (PRD decision 23). A URL the safety module refuses is classified like
 * any other unreachable endpoint — `timed_out` — while a syntactically bad
 * base URL is rejected at the first call, where the operator can fix it.
 *
 * Failures are classified with the shared vocabulary and never carry a
 * provider's response body, because a provider is free to echo the key it just
 * rejected.
 *
 * The connection is generic on purpose (PRD "Out of Scope"): the URL, the
 * credential name and the model id are the whole configuration, and a vendor
 * feature that cannot be expressed through them waits rather than growing a
 * provider-specific option or environment variable here.
 */

export interface OpenAiCompatibleModelRuntimeOptions {
  /** Resolves the endpoint's API key by name; the value never appears in configuration. */
  readonly credentials: CredentialStore;
  /**
   * Transport seam for the offline emulator, which speaks plain HTTP on
   * loopback; defaults to the URL-safety module's `safeFetch` (PRD decision 23).
   */
  readonly fetch?: SafeFetch;
  /**
   * Budget for discovery, the probe and the first byte of a turn; defaults to
   * 30 seconds. An endpoint that did not answer its headers inside the budget
   * is `timed_out`.
   */
  readonly timeoutMs?: number;
  /**
   * Idle budget between stream frames; defaults to 60 seconds. A stream that
   * stalls past it is `timed_out`, so a turn cannot hang forever on an
   * endpoint that accepted the request and then stopped talking.
   */
  readonly idleTimeoutMs?: number;
}

const defaultTimeoutMs = 30_000;
const defaultIdleTimeoutMs = 60_000;

/** The header the probe sets on its streaming verification request. */
export const modelProbeHeader = "x-porkbot-probe";

/**
 * The transport one wire client talks through: the URL-safety module's
 * `safeFetch` in a deployment, the emulator's loopback transport offline.
 */
export interface OpenAiWireTransport {
  readonly dial: SafeFetch;
  /**
   * Resolves the credential for a connection. The deployment wraps the
   * `CredentialStore` and raises `CredentialMissingError`; the emulator answers
   * its scripted key.
   */
  readonly credential: (connection: ModelConnection) => Promise<string>;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

interface ToolAccumulator {
  callId: string;
  name: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The address of one operation under a base URL. A base URL that is not an
 * absolute http(s) URL without embedded credentials, a query or a fragment is
 * refused here: the wire cannot be joined to it, and silently appending to a
 * bad string is how a request ends up somewhere nobody chose.
 */
export function openAiEndpoint(baseUrl: string, path: string): URL {
  const trimmed = baseUrl.trim();

  if (trimmed === "") {
    throw new ModelProviderError("not_found", "the connection has no base URL");
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new ModelProviderError("not_found", "the connection's base URL is not an absolute URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ModelProviderError(
      "not_found",
      `the connection's base URL uses "${url.protocol}" instead of http(s)`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new ModelProviderError(
      "not_found",
      "the connection's base URL embeds credentials; store the key in the credential store",
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new ModelProviderError(
      "not_found",
      "the connection's base URL carries a query string or fragment",
    );
  }

  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return new URL(`${base}/${path}`);
}

/** The OpenAI chat request body for one provider-neutral turn. */
export function openAiRequestBody(request: ModelTurnRequest): unknown {
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

/**
 * The shared vocabulary for one HTTP status, as the request path maps it. A
 * 5xx lands on `timed_out` rather than a sixth kind: the vocabulary is closed
 * and "the provider did not answer" is the decision a caller can act on —
 * retry — while a raw server error is the provider's business. The mapping is
 * pinned by the suite beside this module so a future edit is deliberate.
 */
export function openAiStatusKind(status: number): ProviderFailureKind {
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

/**
 * The models an OpenAI-shaped discovery response offers, or `undefined` when
 * the payload is not that shape. Only the standard `id` is read: a display
 * name is not part of the wire contract, so the generic connection does not
 * invent one and the feature waits. An entry without a string id is dropped
 * rather than failing the probe: a list that carries an entry the wire cannot
 * name still names the ones it can.
 */
export function parseOpenAiModelList(payload: unknown): ModelDescriptor[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) {
    return undefined;
  }

  return payload["data"].flatMap((candidate): ModelDescriptor[] => {
    return isRecord(candidate) && typeof candidate["id"] === "string"
      ? [{ id: candidate["id"] }]
      : [];
  });
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

function toolDeltas(value: unknown, tools: Map<number, ToolAccumulator>): ModelStreamEvent[] {
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

type StreamChunk = Awaited<ReturnType<ReadableStreamDefaultReader<string>["read"]>>;

async function nextChunk(
  reader: ReadableStreamDefaultReader<string>,
  idleTimeoutMs: number,
  onIdle: (() => void) | undefined,
): Promise<StreamChunk> {
  if (idleTimeoutMs <= 0) {
    return reader.read();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onIdle?.();
      reject(new ModelProviderError("timed_out", "the model stream stalled"));
    }, idleTimeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The data payloads of one SSE response, in order. Comments and event names
 * are ignored; a multi-line `data:` frame is joined the way the SSE spec says.
 */
export async function* openAiSseData(
  response: Response,
  idleTimeoutMs = 0,
  onIdle?: () => void,
): AsyncGenerator<string> {
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
  let done = false;

  try {
    while (!done) {
      const read = await nextChunk(reader, idleTimeoutMs, onIdle);
      buffer += read.value ?? "";
      done = read.done === true;

      // A final line without a trailing newline is still a line: a server that
      // ends `data: {...}` at EOF must not lose its last frame to a parser that
      // only ever sees complete lines.
      for (let newline = buffer.indexOf("\n"); newline >= 0 || (done && buffer.length > 0);) {
        const rawLine = newline >= 0 ? buffer.slice(0, newline) : buffer;
        buffer = newline >= 0 ? buffer.slice(newline + 1) : "";
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          if (dataLines.length > 0) {
            yield dataLines.join("\n");
            dataLines = [];
          }
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }

        newline = buffer.indexOf("\n");
      }
    }

    if (dataLines.length > 0) {
      yield dataLines.join("\n");
    }
  } finally {
    // Release the body on every exit — a completed turn, an idle stall or a
    // consumer that stopped reading — so a stalled stream cannot hold the
    // socket open after the failure has been reported.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * One complete streaming turn as provider-neutral events. The iterable ends
 * after exactly one `completed` event; a truncation, an unparsable frame or a
 * stalled stream raises a classified failure, so a consumer cannot mistake a
 * partial turn for a finished one.
 */
export async function* openAiStreamEvents(
  response: Response,
  options: { readonly idleTimeoutMs?: number; readonly onIdle?: () => void } = {},
): AsyncGenerator<ModelStreamEvent> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    throw new ModelProviderError(
      "timed_out",
      "the endpoint did not answer a streaming request with an event stream",
      response.status,
    );
  }

  const tools = new Map<number, ToolAccumulator>();
  let completed = false;

  try {
    for await (const data of openAiSseData(response, options.idleTimeoutMs ?? 0, options.onIdle)) {
      if (data === "[DONE]") {
        break;
      }

      let payload: unknown;

      try {
        payload = JSON.parse(data) as unknown;
      } catch (cause) {
        throw new ModelProviderError("timed_out", "the endpoint sent invalid SSE JSON", undefined, {
          cause,
        });
      }

      const choice = firstChoice(payload);

      if (choice === undefined || !isRecord(choice["delta"])) {
        continue;
      }

      if (typeof choice["delta"]["content"] === "string") {
        yield { type: "text.delta", delta: choice["delta"]["content"] };
      }

      for (const event of toolDeltas(choice["delta"]["tool_calls"], tools)) {
        yield event;
      }

      const reason = finishReason(choice["finish_reason"]);

      if (reason !== undefined) {
        for (const [, tool] of [...tools].sort(([left], [right]) => left - right)) {
          let argumentsValue: unknown;

          try {
            argumentsValue = JSON.parse(tool.arguments) as unknown;
          } catch (cause) {
            throw new ModelProviderError(
              "timed_out",
              "the endpoint sent invalid tool arguments",
              undefined,
              { cause },
            );
          }

          yield {
            type: "tool.requested",
            callId: tool.callId,
            name: tool.name,
            arguments: argumentsValue,
          };
        }

        // The turn ends at the first finish reason. A server that repeats it
        // must not produce a second `tool.requested` or `completed`: the seam
        // promises exactly one terminal event.
        yield { type: "completed", finishReason: reason };
        completed = true;
        return;
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

function combinedSignal(caller: AbortSignal | undefined, budget: AbortSignal): AbortSignal {
  return caller === undefined ? budget : AbortSignal.any([caller, budget]);
}

/** The wire client both the shipped provider and the offline emulator use. */
export interface OpenAiWire {
  probe(connection: ModelConnection): Promise<ModelProbeResult>;
  stream(request: ModelTurnRequest): AsyncGenerator<ModelStreamEvent>;
}

export function createOpenAiWire(transport: OpenAiWireTransport): OpenAiWire {
  const timeoutMs = transport.timeoutMs ?? defaultTimeoutMs;
  const idleTimeoutMs = transport.idleTimeoutMs ?? defaultIdleTimeoutMs;

  async function send(
    connection: ModelConnection,
    path: string,
    init: {
      readonly method: "GET" | "POST";
      readonly body?: unknown;
      readonly signal?: AbortSignal | undefined;
      /** Extra headers the operation adds, e.g. the probe's marker. */
      readonly headers?: Readonly<Record<string, string>>;
      /**
       * A streaming request's budget covers the headers only; its body is
       * governed by the idle watchdog instead, so a long generation is not cut
       * off at the request budget.
       */
      readonly streaming?: boolean;
    },
  ): Promise<Response> {
    const credential = await transport.credential(connection);
    const headers = {
      authorization: `Bearer ${credential}`,
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    };
    const url = openAiEndpoint(connection.baseUrl, path);
    const request = {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    } as const;

    try {
      if (init.streaming !== true) {
        return await transport.dial(url, {
          ...request,
          signal: combinedSignal(init.signal, AbortSignal.timeout(timeoutMs)),
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        return await transport.dial(url, {
          ...request,
          signal: combinedSignal(init.signal, controller.signal),
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (cause) {
      if (cause instanceof BlockedUrlError) {
        throw new ModelProviderError(
          "timed_out",
          "the endpoint is not reachable under the URL-safety rules",
          undefined,
          { cause },
        );
      }

      throw new ModelProviderError("timed_out", "the endpoint did not answer", undefined, {
        cause,
      });
    }
  }

  /**
   * A real streaming check: the probe asks the endpoint for a stream and reads
   * only the response headers, then releases the body, so "streaming" is what
   * the endpoint did rather than what a feature list claimed. A refusal that
   * names the request itself (400, 422, 501) is an endpoint without streaming
   * support; an auth, quota or missing-model refusal is the classified failure
   * it is.
   */
  async function verifyStreaming(connection: ModelConnection, model: string): Promise<boolean> {
    const response = await send(connection, "chat/completions", {
      method: "POST",
      body: {
        model,
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      },
      headers: { [modelProbeHeader]: "model" },
    });

    if (response.ok) {
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      await response.body?.cancel();
      return contentType.includes("text/event-stream");
    }

    if (response.status === 400 || response.status === 422 || response.status === 501) {
      await response.body?.cancel();
      return false;
    }

    throw new ModelProviderError(
      openAiStatusKind(response.status),
      "the endpoint refused the streaming probe",
      response.status,
    );
  }

  return {
    async probe(connection: ModelConnection): Promise<ModelProbeResult> {
      const response = await send(connection, "models", { method: "GET" });

      if (!response.ok) {
        throw new ModelProviderError(
          openAiStatusKind(response.status),
          "the model endpoint refused discovery",
          response.status,
        );
      }

      let payload: unknown;

      try {
        payload = await response.json();
      } catch (cause) {
        throw new ModelProviderError("timed_out", "the model list was not JSON", response.status, {
          cause,
        });
      }

      const models = parseOpenAiModelList(payload);

      if (models === undefined) {
        throw new ModelProviderError(
          "timed_out",
          "the model list had an invalid shape",
          response.status,
        );
      }

      const first = models[0];

      return {
        reachable: true,
        models,
        streaming: first === undefined ? false : await verifyStreaming(connection, first.id),
      };
    },

    async *stream(request: ModelTurnRequest): AsyncGenerator<ModelStreamEvent> {
      const controller = new AbortController();
      const onIdle = (): void => {
        controller.abort();
      };
      const response = await send(request.connection, "chat/completions", {
        method: "POST",
        body: openAiRequestBody(request),
        signal:
          request.abortSignal === undefined
            ? controller.signal
            : AbortSignal.any([request.abortSignal, controller.signal]),
        streaming: true,
      });

      if (!response.ok) {
        throw new ModelProviderError(
          openAiStatusKind(response.status),
          "the model endpoint refused the turn",
          response.status,
        );
      }

      yield* openAiStreamEvents(response, { idleTimeoutMs, onIdle });
    },
  };
}

/**
 * The shipped real provider: any OpenAI-compatible endpoint, hosted or
 * self-hosted, by URL and stored credential name, with no provider-specific
 * environment variable and no vendor SDK.
 */
export function createOpenAiCompatibleModelRuntime(
  options: OpenAiCompatibleModelRuntimeOptions,
): ModelRuntimeProvider {
  return createOpenAiWire({
    dial: options.fetch ?? safeFetch,
    credential: async (connection) => {
      const value = await options.credentials.resolve(connection.credentialName);

      if (value === undefined || value.trim() === "") {
        throw new CredentialMissingError(connection.credentialName);
      }

      return value;
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
}
