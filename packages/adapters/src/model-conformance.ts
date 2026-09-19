import type {
  ModelConnection,
  ModelRuntimeProvider,
  ModelStreamEvent,
  ModelTurnRequest,
} from "@porkbot/adapter-kit";
import { PROVIDER_FAILURE_KINDS } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import type { ModelEmulatorScript } from "./model-emulator.ts";

/**
 * The provider-neutral model runtime contract.
 *
 * Both shipped implementations register the same harness factory here — the
 * offline emulator's scripted provider half and the real OpenAI-compatible
 * adapter pointed at the emulator over the loopback wire — so text streaming,
 * tool reconstruction, probe semantics and failure classification cannot drift
 * between what is tested offline and what ships.
 */

export interface ModelRuntimeHarness {
  readonly runtime: ModelRuntimeProvider;
  readonly connection: ModelConnection;
}

export type ModelRuntimeHarnessFactory = (
  script: ModelEmulatorScript,
) => Promise<ModelRuntimeHarness>;

export async function collectModelEvents(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

export function modelTurnRequest(
  connection: ModelConnection,
  model = "fixture-model",
): ModelTurnRequest {
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

export function modelRuntimeConformance(name: string, create: ModelRuntimeHarnessFactory): void {
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

      await expect(
        collectModelEvents(harness.runtime.stream(modelTurnRequest(harness.connection))),
      ).resolves.toEqual([
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

      await expect(
        collectModelEvents(harness.runtime.stream(modelTurnRequest(harness.connection))),
      ).resolves.toEqual([
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

    it.each(PROVIDER_FAILURE_KINDS)("classifies a scripted %s refusal", async (kind) => {
      const harness = await create({ turns: [{ failure: kind }] });

      await expect(
        collectModelEvents(harness.runtime.stream(modelTurnRequest(harness.connection))),
      ).rejects.toMatchObject({
        kind,
      });
    });
  });
}
