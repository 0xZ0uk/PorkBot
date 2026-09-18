import type {
  ModelConnection,
  ModelRuntimeProvider,
  ModelStreamEvent,
  ModelTurnRequest,
  ProviderFailureKind,
} from "@porkbot/adapter-kit";
import { PROVIDER_FAILURE_KINDS } from "@porkbot/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { ModelEmulator } from "./index.ts";
import type { ModelEmulatorScript } from "./index.ts";

interface RuntimeHarness {
  readonly runtime: ModelRuntimeProvider;
  readonly connection: ModelConnection;
}

type RuntimeHarnessFactory = (script: ModelEmulatorScript) => Promise<RuntimeHarness>;

const openEmulators: ModelEmulator[] = [];

afterEach(async () => {
  await Promise.all(openEmulators.splice(0).map((emulator) => emulator.stop()));
});

async function createEmulator(script: ModelEmulatorScript): Promise<ModelEmulator> {
  const emulator = await ModelEmulator.start(script);
  openEmulators.push(emulator);
  return emulator;
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

function turn(connection: ModelConnection, model = "fixture-model"): ModelTurnRequest {
  return {
    connection,
    model,
    messages: [{ role: "user", content: "What is the weather?" }],
    tools: [
      {
        name: "weather",
        description: "Read the weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
  };
}

/**
 * The provider-neutral model runtime contract. New real adapters register the
 * same harness factory here, so text streaming, tool reconstruction and probe
 * semantics cannot drift between the offline and hosted implementations.
 */
function modelRuntimeConformance(name: string, create: RuntimeHarnessFactory): void {
  describe(`${name} model runtime conformance`, () => {
    it("probes the models and streaming support", async () => {
      const harness = await create({ models: ["fixture-model", "fallback-model"], turns: [] });

      await expect(harness.runtime.probe(harness.connection)).resolves.toEqual({
        reachable: true,
        models: [{ id: "fixture-model" }, { id: "fallback-model" }],
        streaming: true,
      });
    });

    it("streams text and ends exactly once", async () => {
      const harness = await create({
        turns: [
          {
            steps: [
              { type: "text", delta: "Hello" },
              { type: "text", delta: " world" },
            ],
          },
        ],
      });

      await expect(collect(harness.runtime.stream(turn(harness.connection)))).resolves.toEqual([
        { type: "text.delta", delta: "Hello" },
        { type: "text.delta", delta: " world" },
        { type: "completed", finishReason: "stop" },
      ]);
    });

    it("preserves tool argument deltas and emits one completed call", async () => {
      const harness = await create({
        turns: [
          {
            steps: [
              {
                type: "tool_call",
                callId: "call-1",
                name: "weather",
                argumentDeltas: ['{"city":', '"Lisbon"}'],
              },
            ],
          },
        ],
      });

      await expect(collect(harness.runtime.stream(turn(harness.connection)))).resolves.toEqual([
        { type: "tool.delta", callId: "call-1", argumentsDelta: '{"city":' },
        { type: "tool.delta", callId: "call-1", argumentsDelta: '"Lisbon"}' },
        {
          type: "tool.requested",
          callId: "call-1",
          name: "weather",
          arguments: { city: "Lisbon" },
        },
        { type: "completed", finishReason: "tool_calls" },
      ]);
    });
  });
}

modelRuntimeConformance("offline emulator", async (script) => {
  const emulator = await createEmulator(script);
  return { runtime: emulator, connection: emulator.connection };
});

describe("the model emulator wire protocol", () => {
  it("serves OpenAI-compatible model discovery and deterministic SSE chunks", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [
        {
          steps: [
            { type: "text", delta: "Checking " },
            {
              type: "tool_call",
              callId: "call-1",
              name: "weather",
              argumentDeltas: ['{"city":', '"Lisbon"}'],
            },
          ],
        },
      ],
    });

    const models = await fetch(`${emulator.baseUrl}/models`);
    expect(await models.json()).toEqual({
      object: "list",
      data: [{ id: "fixture-model", object: "model", created: 0, owned_by: "porkbot" }],
    });

    const response = await fetch(`${emulator.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture-model",
        messages: [{ role: "user", content: "weather" }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

    const frames = (await response.text()).trim().split("\n\n");
    expect(frames.at(-1)).toBe("data: [DONE]");

    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame.slice(6)) as unknown);
    expect(chunks).toEqual([
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-model",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-model",
        choices: [{ index: 0, delta: { content: "Checking " }, finish_reason: null }],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "weather", arguments: '{"city":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"Lisbon"}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]);
  });

  it("gates suspension, accepts a steering turn and reaches a compaction fixture", async () => {
    const initial = [{ role: "user", content: "start" }] as const;
    const steered = [...initial, { role: "user", content: "steer: be concise" }] as const;
    const compacted = [
      { role: "system", content: "Summary: user asked to start and then requested brevity." },
      { role: "user", content: "continue" },
    ] as const;
    const emulator = await createEmulator({
      turns: [
        {
          expect: { messages: initial },
          steps: [
            { type: "gate", name: "approval", reason: "suspension" },
            { type: "text", delta: "resumed" },
          ],
        },
        {
          expect: { messages: initial },
          steps: [{ type: "gate", name: "steer", reason: "steering" }],
        },
        {
          expect: { messages: steered },
          steps: [{ type: "text", delta: "concise" }],
        },
        {
          expect: { messages: compacted },
          steps: [{ type: "gate", name: "compact", reason: "compaction" }],
          finishReason: "length",
        },
      ],
    });

    const runAtGate = async (
      name: string,
      messages: ModelTurnRequest["messages"],
    ): Promise<ModelStreamEvent[]> => {
      const result = collect(
        emulator.stream({
          connection: emulator.connection,
          model: "fixture-model",
          messages,
        }),
      );
      await emulator.waitForGate(name);
      emulator.releaseGate(name);
      return result;
    };

    await expect(runAtGate("approval", initial)).resolves.toEqual([
      { type: "text.delta", delta: "resumed" },
      { type: "completed", finishReason: "stop" },
    ]);

    const steeringAbort = new AbortController();
    const interrupted = collect(
      emulator.stream({
        connection: emulator.connection,
        model: "fixture-model",
        messages: initial,
        abortSignal: steeringAbort.signal,
      }),
    );
    await emulator.waitForGate("steer");
    steeringAbort.abort();
    await expect(interrupted).rejects.toMatchObject({ kind: "timed_out" });
    await emulator.waitForGateExit("steer");

    await expect(
      collect(
        emulator.stream({
          connection: emulator.connection,
          model: "fixture-model",
          messages: steered,
        }),
      ),
    ).resolves.toEqual([
      { type: "text.delta", delta: "concise" },
      { type: "completed", finishReason: "stop" },
    ]);
    await expect(runAtGate("compact", compacted)).resolves.toEqual([
      { type: "completed", finishReason: "length" },
    ]);
    expect(emulator.requests.map((request) => request.messages)).toEqual([
      initial,
      initial,
      steered,
      compacted,
    ]);
  });

  it.each(PROVIDER_FAILURE_KINDS)("injects an OpenAI-shaped %s failure", async (kind) => {
    const emulator = await createEmulator({ turns: [{ failure: kind }] });

    await expect(collect(emulator.stream(turn(emulator.connection)))).rejects.toMatchObject({
      name: "ModelProviderError",
      kind,
    });
  });

  it("uses the documented status and error envelope for every failure", async () => {
    const expected: Readonly<Record<ProviderFailureKind, readonly [number, string, string]>> = {
      gone: [410, "invalid_request_error", "gone"],
      not_found: [404, "invalid_request_error", "model_not_found"],
      rate_limited: [429, "rate_limit_error", "rate_limit_exceeded"],
      timed_out: [504, "server_error", "timeout"],
      auth_failed: [401, "authentication_error", "invalid_api_key"],
    };
    const emulator = await createEmulator({
      turns: PROVIDER_FAILURE_KINDS.map((failure) => ({ failure })),
    });

    for (const kind of PROVIDER_FAILURE_KINDS) {
      const [status, type, code] = expected[kind];
      const response = await fetch(`${emulator.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture-model", messages: [], stream: true }),
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: {
          message: `The scripted model emulator produced ${code}.`,
          type,
          code,
        },
      });
    }
  });

  it("produces the same event and request sequence for the same script", async () => {
    const script: ModelEmulatorScript = {
      turns: [
        {
          steps: [
            { type: "text", delta: "one" },
            { type: "text", delta: " two" },
          ],
        },
      ],
    };
    const first = await createEmulator(script);
    const second = await createEmulator(script);

    const [firstEvents, secondEvents] = await Promise.all([
      collect(first.stream(turn(first.connection))),
      collect(second.stream(turn(second.connection))),
    ]);

    expect(firstEvents).toEqual(secondEvents);
    expect(first.requests).toEqual(second.requests);
  });

  it("rejects overlapping turns instead of assigning scripts by arrival timing", async () => {
    const emulator = await createEmulator({
      turns: [
        { steps: [{ type: "gate", name: "only-turn", reason: "suspension" }] },
        { steps: [{ type: "text", delta: "second" }] },
      ],
    });
    const first = collect(emulator.stream(turn(emulator.connection)));
    await emulator.waitForGate("only-turn");

    const overlap = await fetch(`${emulator.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", messages: [], stream: true }),
    });

    expect(overlap.status).toBe(409);
    await expect(overlap.json()).resolves.toEqual({
      error: {
        message: "The scripted model emulator produced concurrent_turn.",
        type: "invalid_request_error",
        code: "concurrent_turn",
      },
    });

    emulator.releaseGate("only-turn");
    await first;
    await expect(collect(emulator.stream(turn(emulator.connection)))).resolves.toEqual([
      { type: "text.delta", delta: "second" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("fails closed when a caller names a different endpoint", async () => {
    const emulator = await createEmulator({ turns: [] });

    await expect(
      emulator.probe({ baseUrl: "http://127.0.0.1:1/v1", credentialName: "none" }),
    ).rejects.toEqual(expect.objectContaining({ kind: "not_found" }));
  });
});
