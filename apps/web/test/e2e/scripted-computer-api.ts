import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type {
  Bot,
  ComputerFileEntryView,
  ComputerProvidersView,
  ComputerSnapshotView,
  ComputerView,
} from "@porkbot/contracts";

/**
 * A computer API for the e2e suite and for capturing the screen: a real HTTP
 * server that speaks oRPC's RPC wire by hand, on port 0, with no supervisor,
 * no key and no database.
 *
 * The server holds the bot's stored selection, the deployment's provider list,
 * one machine and one small home in memory, and applies the same decisions the
 * real services do: a provider write moves the bot row, a capture appends a
 * snapshot, a restore brings the machine back running, each lifecycle verb
 * leaves the machine in the state its name promises, a terminal command is
 * echoed, and the home's listing and file bytes come back through the same
 * procedures the supervisor's exec seam backs. A kind the scripted deployment
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

  /** The machine's home: one small tree the file view can walk. */
  const home: Readonly<Record<string, string>> = {
    "notes.md": "# Notes\n",
    "projects/readme.md": "hello\n",
  };

  /** The entries one home-relative directory holds, derived from the file map. */
  function entriesOf(path: string): ComputerFileEntryView[] {
    const prefix = path === "" ? "" : `${path}/`;
    const names = new Map<string, ComputerFileEntryView>();

    for (const [filePath, content] of Object.entries(home)) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }

      const remainder = filePath.slice(prefix.length);

      if (remainder === "" || remainder.includes("/")) {
        continue;
      }

      names.set(remainder, { name: remainder, kind: "file", sizeBytes: content.length });
    }

    const directories = new Set(
      Object.keys(home)
        .filter(
          (filePath) => filePath.startsWith(prefix) && filePath.slice(prefix.length).includes("/"),
        )
        .map((filePath) => filePath.slice(prefix.length).split("/", 1)[0] ?? ""),
    );

    for (const name of directories) {
      names.set(name, { name, kind: "directory", sizeBytes: 0 });
    }

    return [...names.values()].sort((left, right) => (left.name < right.name ? -1 : 1));
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
      case "computers/boot":
        computer = { assigned: true, state: "running", instanceId: "booted-1" };
        return computer;
      case "computers/stop":
        computer = { assigned: true, state: "stopped" };
        return computer;
      case "computers/reset":
        computer = { assigned: true, state: "running", instanceId: "reset-1" };
        return computer;
      case "computers/recover":
        computer = { assigned: true, state: "running", instanceId: "recovered-1" };
        return computer;
      case "computers/files": {
        const path =
          typeof input === "object" && input !== null && "path" in input
            ? ((input as { path?: string }).path ?? "")
            : "";

        return { path, entries: entriesOf(path) };
      }
      case "computers/file": {
        const path =
          typeof input === "object" && input !== null && "path" in input
            ? ((input as { path?: string }).path ?? "")
            : "";
        const content = home[path];

        return content === undefined
          ? undefined
          : { path, content, truncated: content.length > 64 };
      }
      case "computers/terminal": {
        const command =
          typeof input === "object" && input !== null && "command" in input
            ? ((input as { command?: string }).command ?? "")
            : "";

        return command.includes("fail")
          ? { exitCode: 1, stdout: "", stderr: "the command failed\n", truncated: false }
          : { exitCode: 0, stdout: `ran: ${command}\n`, stderr: "", truncated: false };
      }
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

    if (value === undefined) {
      // A missing file is the contract's typed NOT_FOUND; every other absent
      // answer this script can give is the refused provider write.
      if (path === "computers/file") {
        writeError(response, 404, "NOT_FOUND");
        return;
      }

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
