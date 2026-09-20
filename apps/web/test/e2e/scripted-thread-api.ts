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

/** An upload the scripted API accepted, as the composer's XHR sent it. */
export interface ScriptedUpload {
  readonly id: string;
  readonly threadId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly body: Buffer;
}

export interface ScriptedThreadApi {
  /** The origin, e.g. `http://127.0.0.1:41234`, suitable for a transport. */
  readonly url: string;
  readonly rpcUrl: string;
  /** Every subscribe, in order: how a resume is observable. */
  readonly subscriptions: ScriptedSubscription[];
  /** Every upload the raw route accepted, in order. */
  readonly uploads: ScriptedUpload[];
  /** Every `threads.send` input, in order: the nonce and ids are observable. */
  readonly sends: readonly unknown[];
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
  /**
   * Stored bytes the download route serves for ids that are not uploads —
   * the artifacts a tool event's `downloadPath` points at.
   */
  readonly files?: Readonly<
    Record<
      string,
      { readonly filename: string; readonly contentType: string; readonly body: string }
    >
  >;
}

export async function startScriptedThreadApi(
  options: ScriptedThreadApiOptions,
): Promise<ScriptedThreadApi> {
  const timeline = [...(options.events ?? [])];
  // The transcript a reload reads: the scripted rows plus every message the
  // send route answered, so a second mount sees what persistence would serve.
  const messages: Message[] = [...(options.messages ?? [])];
  const subscriptions: ScriptedSubscription[] = [];
  const uploads: ScriptedUpload[] = [];
  const sends: unknown[] = [];
  const waiters = new Set<() => void>();
  const streams = new Set<ServerResponse>();
  let nextFile = 0;
  let nextMessage = 0;

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

  // jsdom's XHR honours the same-origin policy the way a browser does, so the
  // scripted API answers CORS the way the deployment's one origin makes
  // unnecessary in production: any origin may call these routes.
  function cors(response: ServerResponse): void {
    response.setHeader("access-control-allow-origin", "*");
  }

  function writeJson(response: ServerResponse, value: unknown): void {
    const body = JSON.stringify({ json: value });

    cors(response);
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  /** The oRPC RPC envelope for a defined error, as the real API writes it. */
  function writeError(response: ServerResponse, status: number, code: string): void {
    const body = JSON.stringify({ defined: true, code, status, message: code });

    cors(response);
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

  async function readRawBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks);
  }

  function fileId(sequence: number): string {
    return `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
  }

  /** The raw upload route's half of the contract: name in the query, type in the header. */
  async function uploadAttachment(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const body = await readRawBody(request);
    const filename = url.searchParams.get("filename") ?? "";
    const contentType = request.headers["content-type"] ?? "application/octet-stream";
    const match = /^\/threads\/([^/]+)\/attachments$/.exec(url.pathname);

    if (match?.[1] !== options.threadId || filename === "") {
      writeError(response, 404, "NOT_FOUND");
      return;
    }

    nextFile += 1;
    const uploaded: ScriptedUpload = {
      id: fileId(nextFile),
      threadId: options.threadId,
      filename,
      contentType,
      body,
    };
    uploads.push(uploaded);

    const answer = JSON.stringify({
      id: uploaded.id,
      filename: uploaded.filename,
      contentType: uploaded.contentType,
      sizeBytes: uploaded.body.byteLength,
    });

    cors(response);
    response.writeHead(201, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(answer),
    });
    response.end(answer);
  }

  /** The send procedure: the message is persisted and joins the transcript a reload reads. */
  function sendMessage(response: ServerResponse, input: unknown): void {
    const record = (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >;

    if (record["threadId"] !== options.threadId) {
      writeError(response, 404, "NOT_FOUND");
      return;
    }

    sends.push(input);
    nextMessage += 1;

    const attachmentIds = Array.isArray(record["attachmentIds"])
      ? (record["attachmentIds"] as string[])
      : [];
    const files = attachmentIds.flatMap((id) => {
      const upload = uploads.find((candidate) => candidate.id === id);

      return upload === undefined
        ? []
        : [
            {
              type: "file" as const,
              attachmentId: upload.id,
              filename: upload.filename,
              contentType: upload.contentType,
              sizeBytes: upload.body.byteLength,
            },
          ];
    });
    const message: Message = {
      id: fileId(0x1000 + nextMessage),
      threadId: options.threadId,
      seq: messages.length,
      role: "user",
      blocks: [{ type: "text", text: String(record["text"] ?? "") }, ...files],
      runId: `run-${String(nextMessage)}`,
      createdAt: "2026-01-02T00:00:00.000Z",
    };

    messages.push(message);
    writeJson(response, { action: "start_run", message, runId: message.runId });
  }

  /** The download route: uploads and scripted artifacts share the one id space. */
  function downloadFile(response: ServerResponse, url: URL): void {
    const match = /^\/files\/([^/]+)$/.exec(url.pathname);
    const id = match?.[1];
    const upload = uploads.find((candidate) => candidate.id === id);
    const scripted = id === undefined ? undefined : options.files?.[id];
    const body = upload?.body ?? (scripted === undefined ? undefined : Buffer.from(scripted.body));

    if (body === undefined) {
      cors(response);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    cors(response);
    response.writeHead(200, {
      "content-type": upload?.contentType ?? scripted?.contentType ?? "application/octet-stream",
      "content-length": body.byteLength,
    });
    response.end(body);
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
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    // The upload's non-simple content type triggers a preflight in a real
    // browser context; answer it so the XHR proceeds.
    if (request.method === "OPTIONS") {
      cors(response);
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      response.end();
      return;
    }

    // The stored-file routes are plain HTTP outside the RPC envelope: bytes in
    // and bytes out, never the `{json: …}` wrapper.
    if (request.method === "GET" && url.pathname.startsWith("/files/")) {
      downloadFile(response, url);
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/attachments")) {
      await uploadAttachment(request, response, url);
      return;
    }

    if (request.method !== "POST") {
      cors(response);
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    const input = await readBody(request);

    switch (url.pathname) {
      case "/rpc/threads/messages":
        writeJson(response, { messages, nextSeq: null });
        return;
      case "/rpc/threads/send":
        sendMessage(response, input);
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
    uploads,
    sends,

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
