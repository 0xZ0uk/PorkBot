import { Effect, Fiber } from "effect";
import type { RunEvent } from "@porkbot/core";
import { LiveRuns, consumeRunSession, liveRunsLayer, withLiveRun } from "@porkbot/effect";
import type { RunSessionOutcome } from "@porkbot/effect";
import { afterEach, describe, expect, it } from "vitest";
import { ModelEmulator } from "./model-emulator.ts";
import type { ModelEmulatorScript } from "./model-emulator.ts";
import { createLiveAgentRuntimeLayer } from "./pi-agent-source.ts";

/**
 * The live Pi source (slice 6.11): a real `Agent` behind the shipped
 * `PiRunSource` seam, driven over the loopback model wire. Every assertion is a
 * `RunEvent` or a request the emulator recorded, never a Pi internal.
 */

const openEmulators: ModelEmulator[] = [];
const runId = "run-live";
const threadId = "thread-live";

afterEach(async () => {
  await Promise.all(openEmulators.splice(0).map(async (emulator) => emulator.stop()));
});

async function createEmulator(script: ModelEmulatorScript): Promise<ModelEmulator> {
  const emulator = await ModelEmulator.start(script, globalThis.fetch);
  openEmulators.push(emulator);
  return emulator;
}

function layerFor(
  emulator: ModelEmulator,
  input: {
    readonly prompt?: string;
    readonly systemPrompt?: string;
    readonly history?: Parameters<typeof createLiveAgentRuntimeLayer>[0]["history"];
  } = {},
) {
  return createLiveAgentRuntimeLayer({
    runtime: emulator,
    connection: emulator.connection,
    model: "fixture-model",
    runId,
    threadId,
    startSeq: 1,
    systemPrompt: input.systemPrompt ?? "You are a test.",
    history: input.history ?? [],
    prompt: input.prompt ?? "Say hello",
  });
}

function collect(recorded: RunEvent[]) {
  return (event: RunEvent) =>
    Effect.sync(() => {
      recorded.push(event);
    });
}

interface LiveRun {
  readonly recorded: readonly RunEvent[];
  readonly outcome: RunSessionOutcome;
}

async function runToSettlement(
  emulator: ModelEmulator,
  input: Parameters<typeof layerFor>[1] = {},
): Promise<LiveRun> {
  const recorded: RunEvent[] = [];
  const program = Effect.gen(function* () {
    const outcome = yield* withLiveRun(runId, layerFor(emulator, input), (session) =>
      consumeRunSession(session, collect(recorded)),
    );

    return outcome;
  }).pipe(Effect.provide(liveRunsLayer));

  return { recorded, outcome: await Effect.runPromise(program) };
}

describe("the live Pi agent source", () => {
  it("streams the model's text as run events and settles completed", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [
        {
          steps: [
            { type: "text", delta: "Hello " },
            { type: "text", delta: "world" },
          ],
        },
      ],
    });

    const { recorded, outcome } = await runToSettlement(emulator);

    expect(recorded.map((event) => event.type)).toEqual([
      "run.started",
      "token.delta",
      "token.delta",
      "run.completed",
    ]);
    expect(outcome).toEqual({ status: "completed" });

    const text = recorded.flatMap((event) => (event.type === "token.delta" ? [event.delta] : []));
    expect(text).toEqual(["Hello ", "world"]);

    expect(emulator.requests).toHaveLength(1);
    expect(emulator.requests[0]?.messages).toEqual([
      { role: "system", content: "You are a test." },
      { role: "user", content: "Say hello" },
    ]);
  });

  it("replays the prior conversation before the new prompt", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [{ steps: [{ type: "text", delta: "Sure." }] }],
    });

    await runToSettlement(emulator, {
      history: [
        { role: "user", content: "What did I ask?" },
        { role: "assistant", content: "You asked about the report." },
      ],
      prompt: "And now?",
    });

    expect(emulator.requests[0]?.messages).toEqual([
      { role: "system", content: "You are a test." },
      { role: "user", content: "What did I ask?" },
      { role: "assistant", content: "You asked about the report." },
      { role: "user", content: "And now?" },
    ]);
  });

  it("cancels the run when the operator stops it", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [
        {
          steps: [
            { type: "text", delta: "working" },
            { type: "gate", name: "pause", reason: "steering" },
          ],
        },
      ],
    });
    const recorded: RunEvent[] = [];

    const program = Effect.gen(function* () {
      const liveRuns = yield* LiveRuns;

      return yield* withLiveRun(runId, layerFor(emulator), (session) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(consumeRunSession(session, collect(recorded)));
          yield* Effect.tryPromise(() => emulator.waitForGate("pause"));
          yield* liveRuns.dispatch(runId, { type: "stop", reason: "operator stopped it" });

          return yield* Fiber.join(fiber);
        }),
      );
    }).pipe(Effect.provide(liveRunsLayer));

    const outcome = await Effect.runPromise(program);

    expect(outcome).toEqual({ status: "cancelled", reason: "operator stopped it" });
    expect(recorded.at(-1)?.type).toBe("run.cancelled");
  });

  it("injects a steer at the loop's next drain point and continues the turn", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [
        {
          steps: [
            { type: "text", delta: "first" },
            { type: "gate", name: "pause", reason: "steering" },
          ],
        },
        { steps: [{ type: "text", delta: "second" }] },
      ],
    });
    const recorded: RunEvent[] = [];

    const program = Effect.gen(function* () {
      const liveRuns = yield* LiveRuns;

      return yield* withLiveRun(runId, layerFor(emulator), (session) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(consumeRunSession(session, collect(recorded)));
          yield* Effect.tryPromise(() => emulator.waitForGate("pause"));
          yield* liveRuns.dispatch(runId, {
            type: "steer",
            messageId: "message-steer",
            text: "keep going",
          });
          emulator.releaseGate("pause");

          return yield* Fiber.join(fiber);
        }),
      );
    }).pipe(Effect.provide(liveRunsLayer));

    const outcome = await Effect.runPromise(program);

    expect(outcome).toEqual({ status: "completed" });
    expect(recorded.find((event) => event.type === "run.steered")).toMatchObject({
      messageId: "message-steer",
      text: "keep going",
    });
    expect(
      recorded.flatMap((event) => (event.type === "token.delta" ? [event.delta] : [])),
    ).toEqual(["first", "second"]);
    expect(emulator.requests).toHaveLength(2);
    expect(emulator.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "keep going",
    });
  });

  it("executes a tool the model calls and replays the result to the next turn", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [
        {
          steps: [
            { type: "text", delta: "Checking." },
            {
              type: "tool_call",
              callId: "call-1",
              name: "lookup",
              argumentDeltas: ['{"key":', '"answer"}'],
            },
          ],
        },
        { steps: [{ type: "text", delta: "The answer is 42." }] },
      ],
    });
    const recorded: RunEvent[] = [];
    const calls: { callId: string; tool: string; arguments: unknown }[] = [];
    const layer = createLiveAgentRuntimeLayer({
      runtime: emulator,
      connection: emulator.connection,
      model: "fixture-model",
      runId,
      threadId,
      startSeq: 1,
      systemPrompt: "You are a test.",
      history: [],
      prompt: "Look it up",
      tools: [
        {
          definition: {
            name: "lookup",
            description: "Looks something up.",
            parameters: { type: "object", properties: { key: { type: "string" } } },
          },
          execute: async (call) => {
            calls.push(call);

            return { ok: true, value: 42 };
          },
        },
      ],
    });
    const program = Effect.gen(function* () {
      return yield* withLiveRun(runId, layer, (session) =>
        consumeRunSession(session, collect(recorded)),
      );
    }).pipe(Effect.provide(liveRunsLayer));

    const outcome = await Effect.runPromise(program);

    expect(outcome).toEqual({ status: "completed" });
    expect(recorded.map((event) => event.type)).toEqual([
      "run.started",
      "token.delta",
      "tool.requested",
      "tool.completed",
      "token.delta",
      "run.completed",
    ]);
    expect(calls).toEqual([{ callId: "call-1", tool: "lookup", arguments: { key: "answer" } }]);
    expect(recorded.find((event) => event.type === "tool.completed")).toMatchObject({
      result: {
        content: [{ type: "text", text: '{"ok":true,"value":42}' }],
        details: { ok: true, value: 42 },
      },
    });

    // The second request replays the assistant's call and its result, so the
    // endpoint can match the tool message to the call it answers.
    expect(emulator.requests).toHaveLength(2);
    const replayed = emulator.requests[1]?.messages ?? [];
    expect(replayed.find((message) => message.role === "assistant")).toMatchObject({
      toolCalls: [{ callId: "call-1", name: "lookup", arguments: { key: "answer" } }],
    });
    expect(replayed.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      content: '{"ok":true,"value":42}',
      toolCallId: "call-1",
    });
  });

  it("settles failed when the endpoint refuses the turn", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [{ failure: "rate_limited" }],
    });

    const { recorded, outcome } = await runToSettlement(emulator);

    expect(outcome.status).toBe("failed");
    const failed = recorded.at(-1);
    expect(failed?.type).toBe("run.failed");
    expect(failed?.type === "run.failed" ? failed.error : "").toContain("rate_limited");
  });
});
