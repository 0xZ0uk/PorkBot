// Records the golden corpus for the Pi adapter (slice 5.3).
//
// Run `node packages/adapters/scripts/record-pi-fixtures.mjs` from the
// repository after changing the Pi pin, review the diff, then regenerate the
// snapshots (the corpus test prints the mismatch) and run `pnpm format`. The
// events are produced by the real pinned Pi agent loop with a scripted, offline
// stream function, so the fixture shapes are Pi's, not a hand-written guess;
// timestamps are normalised so the recording is stable.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../src/pi-corpus");
const piVersion = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve("@earendil-works/pi-agent-core/package.json"),
    "utf8",
  ),
).version;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
  id: "corpus-model",
  name: "corpus-model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://model.example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
};

class PushStream {
  constructor() {
    this.events = [];
    this.done = false;
    this.waiters = [];
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }
  push(event) {
    this.events.push(event);
    this.waiters.splice(0).forEach((waiter) => waiter());
  }
  end(result) {
    this.done = true;
    if (result !== undefined) {
      this.resolveResult(result);
    }
    this.waiters.splice(0).forEach((waiter) => waiter());
  }
  async next() {
    for (;;) {
      if (this.events.length > 0) {
        return { value: this.events.shift(), done: false };
      }
      if (this.done) {
        return { value: undefined, done: true };
      }
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  result() {
    return this.resultPromise;
  }
}

const assistant = (over = {}) => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason: "stop",
  timestamp: 0,
  ...over,
});

function textResponse(text, reason = "stop") {
  const message = assistant({ content: [{ type: "text", text }], stopReason: reason });
  return {
    events: [
      { type: "start", partial: message },
      { type: "text_start", contentIndex: 0, partial: message },
      { type: "text_delta", contentIndex: 0, delta: text, partial: message },
      { type: "text_end", contentIndex: 0, content: text, partial: message },
      { type: "done", reason, message },
    ],
    result: message,
  };
}

function toolCallResponse(call) {
  const toolCall = { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
  const message = assistant({ content: [toolCall], stopReason: "toolUse" });
  return {
    events: [
      { type: "start", partial: message },
      { type: "toolcall_start", contentIndex: 0, partial: message },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: JSON.stringify(call.arguments),
        partial: message,
      },
      { type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
      { type: "done", reason: "toolUse", message },
    ],
    result: message,
  };
}

function errorResponse(errorMessage) {
  const message = assistant({ content: [], stopReason: "error", errorMessage });
  return {
    events: [
      { type: "start", partial: message },
      { type: "error", reason: "error", error: message },
    ],
    result: message,
  };
}

function scriptedStream(turns) {
  let turn = 0;
  return () => {
    const index = turn;
    turn += 1;
    const stream = new PushStream();
    const response = turns[Math.min(index, turns.length - 1)];
    queueMicrotask(() => {
      for (const event of response.events) {
        stream.push(event);
      }
      stream.end(response.result);
    });
    return stream;
  };
}

const echo = {
  name: "echo",
  label: "Echo",
  description: "Echo the given text",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (_callId, params) => ({
    content: [{ type: "text", text: String(params.text) }],
    details: { echoed: true },
  }),
};

const explode = {
  name: "explode",
  label: "Explode",
  description: "Always throws",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    throw new Error("the corpus tool failed on purpose");
  },
};

async function record(streamFn, { prompt, tools = [] }) {
  const events = [];
  const agent = new Agent({
    initialState: { systemPrompt: "You are the corpus agent.", model, messages: [], tools },
    streamFn,
  });
  agent.subscribe((event) => events.push(event));
  await agent.prompt(prompt);
  return events;
}

function normalize(value) {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === "timestamp" ? 0 : normalize(entry);
    }
    return out;
  }
  return value;
}

// Abort is a real session: the stream stays open, the operator stops it, and
// Pi closes the turn with an aborted assistant message.
async function recordAbort() {
  const events = [];
  let turn = 0;
  const streamFn = (_model, _context, options) => {
    turn += 1;
    const stream = new PushStream();
    const partial = assistant({
      content: [{ type: "text", text: "working" }],
      stopReason: "pending",
    });
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "working", partial });
    options?.signal?.addEventListener(
      "abort",
      () => {
        const aborted = assistant({
          content: [{ type: "text", text: "working" }],
          stopReason: "aborted",
          errorMessage: "the operator stopped the run",
        });
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
      },
      { once: true },
    );
    return stream;
  };
  const agent = new Agent({
    initialState: { systemPrompt: "You are the corpus agent.", model, messages: [] },
    streamFn,
  });
  agent.subscribe((event) => events.push(event));
  const running = agent.prompt("work until stopped");
  await new Promise((resolve) => setTimeout(resolve, 10));
  agent.abort();
  await running;
  if (turn !== 1) {
    throw new Error(`abort scenario expected one turn, saw ${turn}`);
  }
  return events;
}

const sessions = [
  {
    name: "text-turn",
    description: "One assistant turn of streamed text that completes the run.",
    events: await record(scriptedStream([textResponse("Hello from Pi.")]), {
      prompt: "say hello",
    }),
  },
  {
    name: "tool-turn",
    description: "A tool call, its successful execution, then a completing answer.",
    events: await record(
      scriptedStream([
        toolCallResponse({ id: "call-echo-1", name: "echo", arguments: { text: "hi" } }),
        textResponse("Echoed hi."),
      ]),
      { prompt: "echo hi", tools: [echo] },
    ),
  },
  {
    name: "tool-failure",
    description: "A tool that throws, reported as a failed call, then a recovery answer.",
    events: await record(
      scriptedStream([
        toolCallResponse({ id: "call-explode-1", name: "explode", arguments: {} }),
        textResponse("Recovered from the failure."),
      ]),
      { prompt: "explode", tools: [explode] },
    ),
  },
  {
    name: "agent-error",
    description: "The model turn fails, which Pi reports as an error stop reason.",
    events: await record(scriptedStream([errorResponse("the model turn failed")]), {
      prompt: "fail please",
    }),
  },
  {
    name: "aborted",
    description: "The operator stops a live run; Pi closes it as an aborted turn.",
    events: await normalize(await recordAbort()),
  },
];

mkdirSync(outDir, { recursive: true });

const manifest = {
  piVersion,
  sessions: sessions.map((session) => ({
    name: session.name,
    description: session.description,
    events: `${session.name}.events.ts`,
    snapshot: `${session.name}.snapshot.json`,
  })),
};

const camel = (name) =>
  name.replace(/-([a-z0-9])/g, (_match, letter) => letter.toUpperCase()) + "Events";

for (const session of sessions) {
  const header = [
    "// Generated by packages/adapters/scripts/record-pi-fixtures.mjs.",
    `// Recorded from @earendil-works/pi-agent-core ${piVersion} with a scripted,`,
    "// offline stream function. Do not edit by hand: re-run the recorder on a pin",
    "// change and review the diff against PI_EVENT_MAPPING.",
    'import type { AgentEvent } from "@earendil-works/pi-agent-core";',
    "",
    `export const ${camel(session.name)}: readonly AgentEvent[] = `,
  ].join("\n");

  writeFileSync(
    path.join(outDir, `${session.name}.events.ts`),
    `${header}${JSON.stringify(normalize(session.events), null, 2)};\n`,
    "utf8",
  );
}

writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `recorded ${sessions.length} Pi sessions for ${piVersion}; run "pnpm format" before committing`,
);
