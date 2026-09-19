import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type {
  Bot,
  ComputerProvidersView,
  ComputerSnapshotView,
  ComputerView,
} from "@porkbot/contracts";

/**
 * A computer API for the e2e suite and for capturing the screen: a real HTTP
 * server that speaks oRPC's RPC wire by hand, on port 0, with no supervisor,
 * no key and no database.
 *
 * The server holds the bot's stored selection, the deployment's provider list
 * and one machine in memory and applies the same decisions the real services
 * do: a provider write moves the bot row, a capture appends a snapshot, and a
 * restore brings the machine back running. A kind the scripted deployment
 * reports unavailable is refused when a write names it, with the real API's
 * oRPC envelope, so the screen's refusal path is exercised over a socket.
 */

export interface ScriptedComputerApi {
  readonly url: string;
  readonly rpcUrl: string;
  /** Every RPC path the server answered, in order. */
  readonly calls: string[];
  readonly bot: Bot;
  readonly snapshots: readonly ComputerSnapshotView[];
  readonly computer: ComputerView;
  close(): Promise<void>;
}

export interface ScriptedComputerApiOptions {
  readonly bot: Bot;
  readonly providers: ComputerProvidersView;
  readonly computer?: ComputerView;
  readonly snapshots?: readonly ComputerSnapshotView[];
}

export async function startScriptedComputerApi(
  options: ScriptedComputerApiOptions,
): Promise<ScriptedComputerApi> {
  let bot = { ...options.bot };
  let computer: ComputerView = options.computer ?? {
    assigned: true,
    state: "running",
    instanceId: "offline-1",
  };
  let snapshots = [...(options.snapshots ?? [])];
  const calls: string[] = [];

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

  function handle(input: unknown, path: string): unknown {
    switch (path) {
      case "account/me":
        return { userId: "user-1", spaceId: "space-1", role: "owner" };
      case "deployment/status":
        return { kind: "closed" };
      case "bots/get":
        return bot;
      case "computers/providers":
        return options.providers;
      case "computers/status":
        return computer;
      case "computers/snapshots":
        return { snapshots };
      case "computers/snapshot": {
        const snapshot: ComputerSnapshotView = {
          id: `11111111-1111-4111-8111-${String(snapshots.length + 1).padStart(12, "0")}`,
          createdAt: "2026-09-19T15:20:48.000Z",
          sizeBytes: 2_048,
        };

        snapshots = [...snapshots, snapshot];
        return snapshot;
      }
      case "computers/restore":
        computer = { assigned: true, state: "running", instanceId: "restored-1" };
        return computer;
      case "bots/update": {
        const kind =
          typeof input === "object" && input !== null && "computerProvider" in input
            ? ((input as { computerProvider?: string | null }).computerProvider ?? null)
            : null;

        if (
          kind !== null &&
          options.providers.providers.find((provider) => provider.kind === kind)?.available !== true
        ) {
          return undefined;
        }

        bot = { ...bot, computerProvider: kind };
        return bot;
      }
      default:
        return {};
    }
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    const path = (request.url ?? "").replace("/rpc/", "");
    calls.push(path);

    const input = await readBody(request);
    const value = handle(input, path);

    if (path === "bots/update" && value === undefined) {
      writeError(response, 503, "SERVICE_UNAVAILABLE");
      return;
    }

    writeJson(response, value);
  }

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
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
    calls,

    get bot() {
      return bot;
    },
    get snapshots() {
      return snapshots;
    },
    get computer() {
      return computer;
    },

    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
