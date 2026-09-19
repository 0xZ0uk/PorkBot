import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Message } from "@porkbot/contracts";
import type { RunEvent } from "@porkbot/core";

/**
 * A thread API for the console's e2e suite: a real HTTP server that speaks
 * oRPC's RPC and SSE wire by hand, on port 0, with no database and no keys.
 *
 * The suite is about the resume path over a real socket, so the server has
 * exactly three behaviours: answer `threads.messages` with the scripted
 * transcript, replay `threads.events` from the `Last-Event-ID` cursor and keep
 * the stream open for live pushes, and drop every open stream on command. Its
 * cursors are opaque positions (`cursor-<seq>`) — the signature and binding
 * rules are the API's own tests — which is enough for the client to resume
 * from the last frame it saw.
 */

export interface ScriptedSubscription {
  readonly threadId: string;
  /** The `last-event-id` request header, absent on a fresh subscribe. */
  readonly lastEventId: string | undefined;
}

export interface ScriptedThreadApi {
  /** The origin, e.g. `http://127.0.0.1:41234`, suitable for a transport. */
  readonly url: string;
  readonly rpcUrl: string;
  /** Every subscribe, in order: how a resume is observable. */
  readonly subscriptions: ScriptedSubscription[];
  /** Appends a run event and wakes every open stream. */
  push(event: RunEvent): void;
  /** Destroys every open event stream, the way a dropped connection looks. */
  dropConnections(): void;
  close(): Promise<void>;
}

export interface ScriptedThreadApiOptions {
  readonly threadId: string;
  readonly messages?: readonly Message[];
  readonly events?: readonly RunEvent[];
  /**
   * The settled tool results `threads.toolResult` answers, keyed the way the
   * ledger keys them: `runId:callId`.
   */
  readonly toolResults?: Readonly<
    Record<string, { readonly tool: string; readonly result: unknown }>
  >;
}

export async function startScriptedThreadApi(
  options: ScriptedThreadApiOptions,
): Promise<ScriptedThreadApi> {
  const timeline = [...(options.events ?? [])];
  const subscriptions: ScriptedSubscription[] = [];
  const waiters = new Set<() => void>();
  const streams = new Set<ServerResponse>();

  function wake(): void {
    for (const waiter of waiters) {
      waiter();
    }

    waiters.clear();
  }

  function nextWake(closed: Promise<void>): Promise<void> {
    let wakeUp: (() => void) | undefined;
    const woken = new Promise<void>((resolve) => {
      wakeUp = resolve;
      waiters.add(resolve);
    });

    return Promise.race([woken, closed]).finally(() => {
      if (wakeUp !== undefined) {
        waiters.delete(wakeUp);
      }
    });
  }

  function cursorSeq(lastEventId: string | undefined): number {
    const match = /^cursor-(\d+)$/.exec(lastEventId ?? "");

    return match?.[1] === undefined ? 0 : Number(match[1]);
  }

  function writeJson(response: ServerResponse, value: unknown): void {
    const body = JSON.stringify({ json: value });

    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  /** The oRPC RPC envelope for a defined error, as the real API writes it. */
  function writeError(response: ServerResponse, status: number, code: string): void {
    const body = JSON.stringify({ defined: true, code, status, message: code });

    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  function stringField(input: unknown, field: string): string {
    return typeof input === "object" && input !== null
      ? String((input as Record<string, unknown>)[field] ?? "")
      : "";
  }

  async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }

    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    return typeof parsed === "object" && parsed !== null
      ? (parsed as { json?: unknown }).json
      : undefined;
  }

  async function streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    input: unknown,
  ): Promise<void> {
    const threadId =
      typeof input === "object" && input !== null
        ? String((input as { threadId?: unknown }).threadId ?? "")
        : "";
    const header = request.headers["last-event-id"];
    const lastEventId = typeof header === "string" ? header : undefined;

    subscriptions.push({ threadId, lastEventId });

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });

    streams.add(response);

    const closed = new Promise<void>((resolve) => {
      response.on("close", () => resolve());
    });

    let sent = cursorSeq(lastEventId);

    try {
      for (;;) {
        for (const event of timeline.filter((candidate) => candidate.seq > sent)) {
          sent = event.seq;
          response.write(`id: cursor-${event.seq}\n`);
          response.write("event: message\n");
          response.write(`data: ${JSON.stringify({ json: event })}\n\n`);
        }

        await nextWake(closed);

        if (response.destroyed || response.writableEnded) {
          return;
        }
      }
    } finally {
      streams.delete(response);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    const input = await readBody(request);

    switch (request.url) {
      case "/rpc/threads/messages":
        writeJson(response, { messages: options.messages ?? [], nextSeq: null });
        return;
      case "/rpc/threads/toolResult": {
        const stored =
          options.toolResults?.[`${stringField(input, "runId")}:${stringField(input, "callId")}`];

        if (stored === undefined || stringField(input, "threadId") !== options.threadId) {
          writeError(response, 404, "NOT_FOUND");
          return;
        }

        writeJson(response, stored);
        return;
      }
      case "/rpc/threads/events":
        await streamEvents(request, response, input);
        return;
      default:
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
    }
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }

      response.end(JSON.stringify({ error: "internal_error" }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected the scripted API to listen on a TCP address");
  }

  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    rpcUrl: `${url}/rpc`,
    subscriptions,

    push: (event) => {
      timeline.push(event);
      timeline.sort((left, right) => left.seq - right.seq);
      wake();
    },

    dropConnections: () => {
      for (const stream of streams) {
        stream.destroy();
      }

      streams.clear();
    },

    close: async () => {
      for (const stream of streams) {
        stream.destroy();
      }

      streams.clear();
      wake();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
