import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeUsage, textMessage } from "../test/fakes.ts";
import {
  createHttpAuthTransport,
  createHttpConsoleTransport,
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
