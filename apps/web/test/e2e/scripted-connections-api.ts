import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Bot, Credential, ModelConnection, ModelProbe } from "@porkbot/contracts";

/**
 * A connections API for the e2e suite and for capturing the screen: a real
 * HTTP server that speaks oRPC's RPC wire by hand, on port 0, with no database
 * and no keys.
 *
 * The server holds the connections, the masked credentials and the bots in
 * memory and applies the same decisions the durable stores do: a create names
 * a stored key, a default swap moves the single flag, a disconnect removes the
 * connection, a revoke removes the credential, and a probe answers the scripted
 * result while stamping the connection's last use. The credential value never
 * exists on this server at all, which is the point the screen is proving.
 */

export interface ScriptedConnectionsApi {
  /** The origin, e.g. `http://127.0.0.1:41234`, suitable for a transport. */
  readonly url: string;
  readonly rpcUrl: string;
  /** Every RPC path the server answered, in order. */
  readonly calls: string[];
  /** The live state after the writes the suite drove. */
  readonly connections: readonly ModelConnection[];
  readonly credentials: readonly Credential[];
  readonly bots: readonly Bot[];
  close(): Promise<void>;
}

export interface ScriptedConnectionsApiOptions {
  readonly connections?: readonly ModelConnection[];
  readonly credentials?: readonly Credential[];
  readonly bots?: readonly Bot[];
  /** The probe every probe request answers; defaults to one streaming model. */
  readonly probe?: ModelProbe;
  /** A per-connection probe answer, taking precedence over `probe`. */
  readonly probes?: Readonly<Record<string, ModelProbe>>;
}

export async function startScriptedConnectionsApi(
  options: ScriptedConnectionsApiOptions = {},
): Promise<ScriptedConnectionsApi> {
  let connections: ModelConnection[] = [...(options.connections ?? [])];
  let credentials: Credential[] = [...(options.credentials ?? [])];
  let bots: Bot[] = [...(options.bots ?? [])];
  const calls: string[] = [];

  const probe: ModelProbe = options.probe ?? {
    reachable: true,
    models: [{ id: "fixture-model" }],
    streaming: true,
    failure: null,
  };

  function writeJson(response: ServerResponse, value: unknown): void {
    const body = JSON.stringify({ json: value });

    response.writeHead(200, {
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

  function findConnection(id: string): ModelConnection | undefined {
    return connections.find((connection) => connection.id === id);
  }

  function handle(input: unknown, path: string): unknown {
    switch (path) {
      case "account/me":
        return { userId: "user-1", spaceId: "space-1", role: "owner" };
      case "deployment/status":
        return { kind: "closed" };
      case "credentials/list":
        return { credentials };
      case "credentials/store": {
        const name = stringField(input, "name");
        const credential: Credential = {
          id: `credential-${name}`,
          name,
          maskedValue: "••••test",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };

        credentials = [...credentials.filter((existing) => existing.name !== name), credential];

        return credential;
      }
      case "credentials/remove": {
        const name = stringField(input, "name");

        credentials = credentials.filter((credential) => credential.name !== name);

        return { name };
      }
      case "modelConnections/list":
        // The mask is derived per read, exactly as the service derives it, so
        // a revoked credential shows as a missing key on the next list.
        return {
          connections: connections.map((connection) => ({
            ...connection,
            credentialMaskedValue:
              credentials.find((credential) => credential.name === connection.credentialName)
                ?.maskedValue ?? null,
          })),
        };
      case "modelConnections/create": {
        const credentialName = stringField(input, "credentialName");
        const connection: ModelConnection = {
          id: `connection-${String(connections.length + 1)}`,
          label: stringField(input, "label"),
          baseUrl: stringField(input, "baseUrl"),
          credentialName,
          credentialMaskedValue:
            credentials.find((credential) => credential.name === credentialName)?.maskedValue ??
            null,
          defaultModel:
            typeof input === "object" && input !== null && "defaultModel" in input
              ? ((input as { defaultModel?: string | null }).defaultModel ?? null)
              : null,
          isDefault: connections.length === 0,
          lastUsedAt: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };

        connections = [...connections, connection];
        return connection;
      }
      case "modelConnections/setDefault": {
        const id = stringField(input, "id");

        connections = connections.map((connection) => ({
          ...connection,
          isDefault: connection.id === id,
        }));

        return findConnection(id) ?? {};
      }
      case "modelConnections/remove": {
        const id = stringField(input, "id");
        const removed = findConnection(id);

        connections = connections.filter((connection) => connection.id !== id);
        bots = bots.map((bot) =>
          bot.modelConnectionId === id ? { ...bot, modelConnectionId: null } : bot,
        );

        return removed ?? {};
      }
      case "modelConnections/probe": {
        const id = stringField(input, "id");
        const connection = findConnection(id);

        if (connection !== undefined) {
          connections = connections.map((candidate) =>
            candidate.id === id
              ? { ...candidate, lastUsedAt: new Date().toISOString() }
              : candidate,
          );
        }

        return { connectionId: id, probe: options.probes?.[id] ?? probe };
      }
      case "bots/list":
        return { bots };
      case "bots/update": {
        const id = stringField(input, "id");
        const modelConnectionId =
          typeof input === "object" && input !== null && "modelConnectionId" in input
            ? ((input as { modelConnectionId?: string | null }).modelConnectionId ?? null)
            : null;

        bots = bots.map((bot) => (bot.id === id ? { ...bot, modelConnectionId } : bot));

        return bots.find((bot) => bot.id === id) ?? {};
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
    writeJson(response, handle(input, path));
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

    get connections() {
      return connections;
    },
    get credentials() {
      return credentials;
    },
    get bots() {
      return bots;
    },

    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
