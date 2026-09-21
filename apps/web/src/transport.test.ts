import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeRoutine, fakeRoutineOutcome, fakeUsage, textMessage } from "../test/fakes.ts";
import {
  createHttpAuthTransport,
  createHttpConsoleTransport,
  createHttpRoutinesTransport,
  createHttpUsageTransport,
} from "./transport.ts";

/**
 * The transports build the contract's client with an absolute URL. The client
 * parses its endpoint with `new URL`, so the browser's same-origin `/rpc` has
 * to be resolved against the page's origin before the client is built — a
 * relative URL throws before a request is made, which is how the shell used to
 * report "can't reach the server" without ever reaching it. These tests pin
 * the resolved endpoint for both the page default and the desktop wrapper's
 * explicit origin, and the transcript walk that reaches the newest turn.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FetchCall {
  readonly url: string;
  readonly body: string;
}

function stubFetch(value: (call: number) => unknown): { readonly calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(String(input));

    calls.push({ url: request.url, body: await request.clone().text() });

    return new Response(JSON.stringify({ json: value(calls.length - 1) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  return { calls };
}

describe("the web transports", () => {
  it("resolves the console's same-origin RPC endpoint against the page's origin", async () => {
    vi.stubGlobal("location", { origin: "https://console.example.invalid" });
    const fetched = stubFetch(() => ({ messages: [], nextSeq: null }));

    const transport = createHttpConsoleTransport();
    await transport.transcript("thread-1");

    expect(fetched.calls.map((call) => call.url)).toEqual([
      "https://console.example.invalid/rpc/threads/messages",
    ]);
  });

  it("honours an explicit origin, the way the desktop wrapper supplies one", async () => {
    const fetched = stubFetch(() => ({ messages: [], nextSeq: null }));

    const transport = createHttpConsoleTransport({ origin: "https://porkbot.example.invalid" });
    await transport.transcript("thread-1");

    expect(fetched.calls.map((call) => call.url)).toEqual([
      "https://porkbot.example.invalid/rpc/threads/messages",
    ]);
  });

  it("resolves the auth client's endpoint the same way", async () => {
    vi.stubGlobal("location", { origin: "https://console.example.invalid" });
    const fetched = stubFetch(() => ({ userId: "user-1", spaceId: "space-1", role: "owner" }));

    const transport = createHttpAuthTransport();
    const actor = await transport.currentActor();

    expect(actor).toEqual({ userId: "user-1", spaceId: "space-1", role: "owner" });
    expect(fetched.calls.map((call) => call.url)).toEqual([
      "https://console.example.invalid/rpc/account/me",
    ]);
  });

  it("asks for one bot's usage on the resolved endpoint", async () => {
    vi.stubGlobal("location", { origin: "https://console.example.invalid" });
    const usage = fakeUsage({ botId: "bot-1" });
    const fetched = stubFetch(() => usage);

    const transport = createHttpUsageTransport();

    await expect(transport.forBot("bot-1")).resolves.toEqual(usage);
    expect(fetched.calls.map((call) => call.url)).toEqual([
      "https://console.example.invalid/rpc/usage/bot",
    ]);
    expect(JSON.parse(fetched.calls[0]?.body ?? "{}")).toEqual({ json: { botId: "bot-1" } });
  });

  it("maps the routine authoring seam to the contract's routes", async () => {
    vi.stubGlobal("location", { origin: "https://console.example.invalid" });
    const routine = fakeRoutine();
    const outcome = fakeRoutineOutcome();
    const fireTimes = ["2026-01-05T09:00:00.000Z", "2026-01-06T09:00:00.000Z"];
    const fetched = stubFetch((call) => {
      switch (call) {
        case 0:
          return { routines: [routine] };
        case 1:
        case 2:
          return routine;
        case 3:
          return { id: routine.id };
        case 4:
          return { fireTimes };
        case 5:
          return { runId: "run-test-1", threadId: routine.threadId };
        case 6:
          return { outcomes: [outcome] };
        default:
          throw new Error(`unexpected routine request ${String(call)}`);
      }
    });
    const transport = createHttpRoutinesTransport();

    await expect(transport.list("bot-1")).resolves.toEqual([routine]);
    await expect(
      transport.create({
        botId: "bot-1",
        instruction: routine.instruction,
        cron: routine.cron,
        timezone: routine.timezone,
      }),
    ).resolves.toEqual(routine);
    await expect(transport.update({ id: routine.id, enabled: false })).resolves.toEqual(routine);
    await expect(transport.remove(routine.id)).resolves.toEqual({ id: routine.id });
    await expect(
      transport.preview({ cron: routine.cron, timezone: routine.timezone, count: 2 }),
    ).resolves.toEqual(fireTimes);
    await expect(
      transport.testRun({ id: routine.id, clientNonce: "routine-test:nonce-1" }),
    ).resolves.toEqual({ runId: "run-test-1", threadId: routine.threadId });
    await expect(transport.outcomes({ id: routine.id, limit: 20 })).resolves.toEqual([outcome]);

    expect(fetched.calls.map((call) => call.url)).toEqual([
      "https://console.example.invalid/rpc/routines/list",
      "https://console.example.invalid/rpc/routines/create",
      "https://console.example.invalid/rpc/routines/update",
      "https://console.example.invalid/rpc/routines/remove",
      "https://console.example.invalid/rpc/routines/preview",
      "https://console.example.invalid/rpc/routines/testRun",
      "https://console.example.invalid/rpc/routines/outcomes",
    ]);
    expect(fetched.calls.map((call) => JSON.parse(call.body))).toEqual([
      { json: { botId: "bot-1" } },
      {
        json: {
          botId: "bot-1",
          instruction: routine.instruction,
          cron: routine.cron,
          timezone: routine.timezone,
        },
      },
      { json: { id: routine.id, enabled: false } },
      { json: { id: routine.id } },
      { json: { cron: routine.cron, timezone: routine.timezone, count: 2 } },
      { json: { id: routine.id, clientNonce: "routine-test:nonce-1" } },
      { json: { id: routine.id, limit: 20 } },
    ]);
  });

  it("walks the transcript pages forward so the newest turn is included", async () => {
    const first = textMessage({
      id: "message-0",
      threadId: "thread-1",
      seq: 0,
      role: "user",
      text: "old",
    });
    const second = textMessage({
      id: "message-1",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      text: "new",
    });
    const fetched = stubFetch((call) =>
      call === 0 ? { messages: [first], nextSeq: 0 } : { messages: [second], nextSeq: null },
    );

    vi.stubGlobal("location", { origin: "https://console.example.invalid" });
    const transport = createHttpConsoleTransport();
    const messages = await transport.transcript("thread-1");

    expect(messages.map((message) => message.id)).toEqual(["message-0", "message-1"]);
    expect(fetched.calls.map((call) => JSON.parse(call.body))).toEqual([
      { json: { threadId: "thread-1", limit: 100 } },
      { json: { threadId: "thread-1", limit: 100, afterSeq: 0 } },
    ]);
  });
});
