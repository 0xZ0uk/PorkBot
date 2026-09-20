import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelEmulator } from "./model-emulator.ts";
import type { ModelEmulatorScript } from "./model-emulator.ts";
import {
  createPiModel,
  createPiStreamFn,
  PiStreamContextError,
  toModelMessages,
} from "./pi-stream-fn.ts";

/**
 * The stream bridge (slice 6.11): one Pi `Context` in, one assistant turn's
 * event protocol out, over the shipped provider client and a real loopback
 * wire. The tests drive the protocol Pi reduces, not a vendor's internals.
 */

const openEmulators: ModelEmulator[] = [];

afterEach(async () => {
  await Promise.all(openEmulators.splice(0).map(async (emulator) => emulator.stop()));
});

async function createEmulator(script: ModelEmulatorScript): Promise<ModelEmulator> {
  const emulator = await ModelEmulator.start(script, globalThis.fetch);
  openEmulators.push(emulator);
  return emulator;
}

function bridgeFor(emulator: ModelEmulator, model = "fixture-model") {
  const options = { runtime: emulator, connection: emulator.connection, model };

  return { streamFn: createPiStreamFn(options), model: createPiModel(options) };
}

function userContext(text: string, systemPrompt?: string): Context {
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages: [{ role: "user", content: text, timestamp: 0 }],
  };
}

describe("toModelMessages", () => {
  it("carries the system prompt, the turns, and a completed tool exchange", () => {
    const messages = toModelMessages({
      systemPrompt: "You are a test.",
      messages: [
        { role: "user", content: "read it", timestamp: 0 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "On it." },
            {
              type: "toolCall",
              id: "call-1",
              name: "file_read",
              arguments: { path: "report.txt" },
            },
          ],
          api: "openai-completions",
          provider: "porkbot",
          model: "fixture-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "file_read",
          content: [{ type: "text", text: "the contents" }],
          isError: false,
          timestamp: 0,
        },
      ],
    });

    expect(messages).toEqual([
      { role: "system", content: "You are a test." },
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "On it.",
        toolCalls: [{ callId: "call-1", name: "file_read", arguments: { path: "report.txt" } }],
      },
      { role: "tool", content: "the contents", toolCallId: "call-1" },
    ]);
  });

  it("refuses an image rather than dropping it silently", () => {
    expect(() =>
      toModelMessages({
        messages: [
          {
            role: "user",
            content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
            timestamp: 0,
          },
        ],
      }),
    ).toThrow(PiStreamContextError);
  });
});

describe("the Pi stream bridge over the model emulator", () => {
  it("emits the text protocol Pi reduces and a completed message", async () => {
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
    const bridge = bridgeFor(emulator);
    const stream = await bridge.streamFn(bridge.model, userContext("Say hello", "You are a test."));
    const frames = [];

    for await (const frame of stream) {
      frames.push(frame);
    }

    expect(frames.map((frame) => frame.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);

    const deltas = frames.flatMap((frame) => (frame.type === "text_delta" ? [frame.delta] : []));
    expect(deltas).toEqual(["Hello ", "world"]);

    const done = frames.at(-1);
    expect(done?.type).toBe("done");

    if (done?.type === "done") {
      expect(done.reason).toBe("stop");
      expect(done.message.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(done.message.stopReason).toBe("stop");
    }

    // A frame's snapshot is not rewritten by the delta that follows it.
    const first = frames.find((frame) => frame.type === "text_delta");
    expect(first?.type === "text_delta" ? first.partial.content : []).toEqual([
      { type: "text", text: "Hello " },
    ]);

    expect(emulator.requests).toHaveLength(1);
    expect(emulator.requests[0]?.messages).toEqual([
      { role: "system", content: "You are a test." },
      { role: "user", content: "Say hello" },
    ]);
  });

  it("emits a completed tool call and finishes the turn for tools", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [
        {
          steps: [
            { type: "text", delta: "Checking." },
            {
              type: "tool_call",
              callId: "call-1",
              name: "file_read",
              argumentDeltas: ['{"path":', '"report.txt"}'],
            },
          ],
        },
      ],
    });
    const bridge = bridgeFor(emulator);
    const stream = await bridge.streamFn(bridge.model, userContext("read the report"));
    const frames = [];

    for await (const frame of stream) {
      frames.push(frame);
    }

    expect(frames.map((frame) => frame.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_end",
      "done",
    ]);

    const done = frames.at(-1);
    expect(done?.type === "done" ? done.reason : null).toBe("toolUse");
    expect(done?.type === "done" ? done.message.content : []).toEqual([
      { type: "text", text: "Checking." },
      {
        type: "toolCall",
        id: "call-1",
        name: "file_read",
        arguments: { path: "report.txt" },
      },
    ]);
  });

  it("answers a classified refusal as the error event the loop reduces", async () => {
    const emulator = await createEmulator({
      models: ["fixture-model"],
      turns: [{ failure: "auth_failed" }],
    });
    const bridge = bridgeFor(emulator);
    const stream = await bridge.streamFn(bridge.model, userContext("Say hello"));
    const frames = [];

    for await (const frame of stream) {
      frames.push(frame);
    }

    const error = frames.at(-1);
    expect(error?.type).toBe("error");

    if (error?.type === "error") {
      expect(error.reason).toBe("error");
      expect(error.error.stopReason).toBe("error");
      expect(error.error.errorMessage).toContain("auth_failed");
    }
  });
});
