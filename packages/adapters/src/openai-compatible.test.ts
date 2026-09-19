import type { ModelRuntimeProvider } from "@porkbot/adapter-kit";
import { CredentialMissingError } from "@porkbot/effect";
import type { SafeFetch } from "@porkbot/effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryCredentialStore,
  createOpenAiCompatibleModelRuntime,
  ModelEmulator,
} from "./index.ts";
import type { ModelEmulatorScript, MemoryCredentialStore } from "./index.ts";
import {
  collectModelEvents,
  modelRuntimeConformance,
  modelTurnRequest,
} from "./model-conformance.ts";
import {
  openAiSseData,
  openAiStatusKind,
  openAiStreamEvents,
  parseOpenAiModelList,
} from "./openai-compatible.ts";

/**
 * The real OpenAI-compatible provider against the offline emulator over the
 * real wire protocol: no network, no vendor and no key that is real.
 *
 * The conformance suite runs the same harness the emulator's own provider
 * passes, and the suites below prove what only the real adapter can be asked:
 * the key comes from the credential store by name (so it rotates without an
 * env var), a missing key never dials, a non-streaming endpoint is reported
 * honestly, and one client serves a hosted endpoint and a self-hosted one with
 * no code path between them.
 */

const openEmulators: ModelEmulator[] = [];

afterEach(async () => {
  await Promise.all(openEmulators.splice(0).map((emulator) => emulator.stop()));
});

async function startEmulator(script: ModelEmulatorScript): Promise<ModelEmulator> {
  const emulator = await ModelEmulator.start(script, globalThis.fetch);
  openEmulators.push(emulator);
  return emulator;
}

function runtimeFor(store: MemoryCredentialStore): ModelRuntimeProvider {
  return createOpenAiCompatibleModelRuntime({
    credentials: store,
    fetch: globalThis.fetch,
  });
}

modelRuntimeConformance("openai-compatible adapter", async (script) => {
  const emulator = await startEmulator(script);
  const credentials = createMemoryCredentialStore([
    [emulator.connection.credentialName, "sk-conformance"],
  ]);

  return { runtime: runtimeFor(credentials), connection: emulator.connection };
});

describe("the credential", () => {
  it("resolves the key by name from the store and follows a rotation", async () => {
    const emulator = await startEmulator({ apiKey: "sk-first", turns: [] });
    const credentials = createMemoryCredentialStore([
      [emulator.connection.credentialName, "sk-first"],
    ]);
    const runtime = runtimeFor(credentials);

    await expect(runtime.probe(emulator.connection)).resolves.toMatchObject({
      reachable: true,
      streaming: true,
    });

    credentials.set(emulator.connection.credentialName, "sk-second");

    await expect(runtime.probe(emulator.connection)).rejects.toMatchObject({
      name: "ModelProviderError",
      kind: "auth_failed",
    });
  });

  it("fails as a missing credential before anything dials", async () => {
    let dialed = 0;
    const runtime = createOpenAiCompatibleModelRuntime({
      credentials: createMemoryCredentialStore(),
      fetch: async () => {
        dialed += 1;
        throw new Error("the transport must not be reached without a credential");
      },
    });

    await expect(
      runtime.probe({ baseUrl: "https://model.example.invalid/v1", credentialName: "model-key" }),
    ).rejects.toBeInstanceOf(CredentialMissingError);
    await expect(
      collectModelEvents(
        runtime.stream(
          modelTurnRequest({
            baseUrl: "https://model.example.invalid/v1",
            credentialName: "model-key",
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(CredentialMissingError);
    expect(dialed).toBe(0);
  });

  it("refuses a non-HTTPS endpoint through the URL-safety module by default", async () => {
    const runtime = createOpenAiCompatibleModelRuntime({
      credentials: createMemoryCredentialStore([["model-key", "sk-test"]]),
    });

    await expect(
      runtime.probe({ baseUrl: "http://127.0.0.1:1/v1", credentialName: "model-key" }),
    ).rejects.toMatchObject({ name: "ModelProviderError", kind: "timed_out" });
  });
});

describe("the probe", () => {
  it("reports a non-streaming endpoint honestly instead of assuming", async () => {
    const emulator = await startEmulator({
      models: ["fixture-model"],
      streaming: false,
      turns: [],
    });
    const runtime = runtimeFor(
      createMemoryCredentialStore([[emulator.connection.credentialName, "sk-test"]]),
    );

    await expect(runtime.probe(emulator.connection)).resolves.toEqual({
      reachable: true,
      models: [{ id: "fixture-model" }],
      streaming: false,
    });
  });
});

describe("one interface, two endpoints", () => {
  it("serves a hosted provider and a self-hosted endpoint with the same client", async () => {
    const hosted = await startEmulator({
      apiKey: "sk-hosted",
      models: ["hosted-model"],
      turns: [{ steps: [{ type: "text", delta: "hosted" }] }],
    });
    const selfHosted = await startEmulator({
      apiKey: "sk-self-hosted",
      models: ["self-hosted-model"],
      turns: [{ steps: [{ type: "text", delta: "self-hosted" }] }],
    });
    const credentials = createMemoryCredentialStore([
      ["hosted-key", "sk-hosted"],
      ["self-hosted-key", "sk-self-hosted"],
    ]);
    const runtime = createOpenAiCompatibleModelRuntime({
      credentials,
      fetch: globalThis.fetch,
    });
    const hostedConnection = { baseUrl: hosted.baseUrl, credentialName: "hosted-key" };
    const selfHostedConnection = {
      baseUrl: selfHosted.baseUrl,
      credentialName: "self-hosted-key",
    };

    await expect(runtime.probe(hostedConnection)).resolves.toMatchObject({
      reachable: true,
      models: [{ id: "hosted-model" }],
    });
    await expect(runtime.probe(selfHostedConnection)).resolves.toMatchObject({
      reachable: true,
      models: [{ id: "self-hosted-model" }],
    });

    await expect(
      collectModelEvents(runtime.stream(modelTurnRequest(hostedConnection, "hosted-model"))),
    ).resolves.toEqual([
      { type: "text.delta", delta: "hosted" },
      { type: "completed", finishReason: "stop" },
    ]);
    await expect(
      collectModelEvents(
        runtime.stream(modelTurnRequest(selfHostedConnection, "self-hosted-model")),
      ),
    ).resolves.toEqual([
      { type: "text.delta", delta: "self-hosted" },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});

describe("the wire parser", () => {
  it("keeps the last frame when the stream ends without a trailing newline", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\ndata: [DONE]'));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const frames: string[] = [];

    for await (const frame of openAiSseData(response)) {
      frames.push(frame);
    }

    expect(frames).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("classifies an unparsable frame instead of dropping it", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

    await expect(collectModelEvents(openAiStreamEvents(response))).rejects.toMatchObject({
      name: "ModelProviderError",
      kind: "timed_out",
    });
  });

  it("emits exactly one completed event when the server repeats the finish reason", async () => {
    const chunk = (delta: unknown, reason: string | null): string =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              chunk({ content: "hi" }, null) +
                chunk({}, "stop") +
                chunk({}, "stop") +
                "data: [DONE]\n\n",
            ),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

    await expect(collectModelEvents(openAiStreamEvents(response))).resolves.toEqual([
      { type: "text.delta", delta: "hi" },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});

describe("the discovery parser", () => {
  it("reads only the standard model id and refuses a payload that is not a list", () => {
    expect(
      parseOpenAiModelList({ data: [{ id: "a", display_name: "ignored" }, { object: "model" }] }),
    ).toEqual([{ id: "a" }]);
    expect(parseOpenAiModelList({ data: "no" })).toBeUndefined();
    expect(parseOpenAiModelList(null)).toBeUndefined();
  });
});

describe("the status mapping", () => {
  it("pins every refusal to the shared vocabulary", () => {
    expect(openAiStatusKind(401)).toBe("auth_failed");
    expect(openAiStatusKind(403)).toBe("auth_failed");
    expect(openAiStatusKind(404)).toBe("not_found");
    expect(openAiStatusKind(410)).toBe("gone");
    expect(openAiStatusKind(429)).toBe("rate_limited");
    expect(openAiStatusKind(400)).toBe("timed_out");
    expect(openAiStatusKind(500)).toBe("timed_out");
    expect(openAiStatusKind(503)).toBe("timed_out");
  });
});

describe("the budgets", () => {
  it("ends a stalled stream as timed_out and releases the socket", async () => {
    const emulator = await startEmulator({
      turns: [{ steps: [{ type: "gate", name: "stall", reason: "suspension" }] }],
    });
    const runtime = createOpenAiCompatibleModelRuntime({
      credentials: createMemoryCredentialStore([[emulator.connection.credentialName, "sk-test"]]),
      fetch: globalThis.fetch,
      idleTimeoutMs: 25,
    });

    await expect(
      collectModelEvents(runtime.stream(modelTurnRequest(emulator.connection))),
    ).rejects.toMatchObject({ name: "ModelProviderError", kind: "timed_out" });
    await emulator.waitForGateExit("stall");
  });

  it("reports no models and no streaming without dialing a turn", async () => {
    const emulator = await startEmulator({ models: [], turns: [] });
    let calls = 0;
    const counting: SafeFetch = async (url, init) => {
      calls += 1;
      return await globalThis.fetch(url, init);
    };
    const runtime = createOpenAiCompatibleModelRuntime({
      credentials: createMemoryCredentialStore([[emulator.connection.credentialName, "sk-test"]]),
      fetch: counting,
    });

    await expect(runtime.probe(emulator.connection)).resolves.toEqual({
      reachable: true,
      models: [],
      streaming: false,
    });
    expect(calls).toBe(1);
  });
});
