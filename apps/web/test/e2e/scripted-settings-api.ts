import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type {
  Bot,
  BotSecretView,
  McpGrant,
  McpServerDetail,
  McpTool,
  NotificationPreference,
  UsageBot,
} from "@porkbot/contracts";
import { NOTIFICATION_KINDS } from "@porkbot/core";
import type { NotificationKind } from "@porkbot/core";

/**
 * A settings API for the e2e suite: a real HTTP server that speaks oRPC's RPC
 * wire by hand, on port 0, with no database and no keys.
 *
 * It answers every procedure the settings area reads — the session guard's
 * `account.me`, ownership, the bot list, usage, the notification switches, bot
 * secrets and the MCP registry — and applies the writes the durable stores do:
 * a preference flip moves that switch, a secret put stores a row without a
 * value ever crossing back, a forget clears it, an MCP install registers the
 * server, and a removal takes it and its grants away. The consent URL is
 * scripted so the OAuth half of an install is drivable without a provider.
 */

export interface ScriptedSettingsApi {
  readonly url: string;
  readonly rpcUrl: string;
  /** Every RPC path the server answered, in order. */
  readonly calls: string[];
  readonly bots: readonly Bot[];
  /** The windows every usage read asked for, in order. */
  readonly usageWindows: number[];
  readonly preferences: readonly NotificationPreference[];
  readonly secrets: readonly BotSecretView[];
  readonly servers: readonly McpServerDetail[];
  readonly grants: readonly McpGrant[];
  close(): Promise<void>;
}

export interface ScriptedSettingsApiOptions {
  readonly bots?: readonly Bot[];
  readonly ownerEmail?: string | null;
  /** The consent URL an OAuth install answers; `null` for a direct install. */
  readonly authorizationUrl?: string | null;
  readonly secrets?: readonly BotSecretView[];
  readonly servers?: readonly McpServerDetail[];
  /** Live grants as `[serverId, botId]` pairs. */
  readonly grants?: readonly (readonly [string, string])[];
  readonly enabled?: readonly NotificationKind[];
}

export async function startScriptedSettingsApi(
  options: ScriptedSettingsApiOptions = {},
): Promise<ScriptedSettingsApi> {
  const bots = [...(options.bots ?? [])];
  const calls: string[] = [];
  const usageWindows: number[] = [];
  let enabled = new Set<NotificationKind>(options.enabled ?? []);
  let secrets = [...(options.secrets ?? [])];
  let servers = [...(options.servers ?? [])];
  const liveGrants = new Set<string>((options.grants ?? []).map(([id, botId]) => `${id}:${botId}`));

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

  function booleanField(input: unknown, field: string): boolean {
    return (
      typeof input === "object" &&
      input !== null &&
      (input as Record<string, unknown>)[field] === true
    );
  }

  async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }

    if (Buffer.concat(chunks).length === 0) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    return typeof parsed === "object" && parsed !== null
      ? (parsed as { json?: unknown }).json
      : undefined;
  }

  function preferenceView(): readonly NotificationPreference[] {
    return NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: enabled.has(kind) }));
  }

  function summary(server: McpServerDetail) {
    const { tools, ...rest } = server;

    return { ...rest, toolCount: tools.length };
  }

  function liveFor(serverId: string): readonly McpGrant[] {
    return [...liveGrants]
      .filter((entry) => entry.startsWith(`${serverId}:`))
      .map((entry) => ({ botId: entry.slice(serverId.length + 1), revokedAt: null }));
  }

  function findServer(id: string): McpServerDetail | undefined {
    return servers.find((server) => server.id === id);
  }

  function usageFor(botId: string, days: number): UsageBot {
    return {
      botId,
      total: { inputTokens: 1200, outputTokens: 340, reported: 3, unreported: 0 },
      periods:
        days >= 7
          ? [
              {
                startsAt: "2026-01-02T00:00:00.000Z",
                inputTokens: 400,
                outputTokens: 100,
                reported: 1,
                unreported: 0,
              },
            ]
          : [],
    };
  }

  function handle(input: unknown, path: string): unknown {
    switch (path) {
      case "account/me":
        return { userId: "user-1", spaceId: "space-1", role: "owner" };
      case "account/ownership":
        return { role: "owner", ownerEmail: options.ownerEmail ?? "owner@example.invalid" };
      case "deployment/status":
        return { signups: "closed" };
      case "bots/list":
        return { bots };
      case "usage/bot": {
        const days = Number(
          typeof input === "object" && input !== null && "days" in input
            ? ((input as { days?: number }).days ?? 30)
            : 30,
        );

        usageWindows.push(days);

        return usageFor(stringField(input, "botId"), days);
      }
      case "notifications/preferences":
        return { preferences: preferenceView() };
      case "notifications/setPreference": {
        const kind = stringField(input, "kind") as NotificationKind;

        enabled = new Set(enabled);

        if (booleanField(input, "enabled")) {
          enabled.add(kind);
        } else {
          enabled.delete(kind);
        }

        return { preferences: preferenceView() };
      }
      case "botSecrets/list":
        return { secrets };
      case "botSecrets/put": {
        const row: BotSecretView = {
          name: stringField(input, "name"),
          status: "stored",
          origin: stringField(input, "origin"),
          auth:
            typeof input === "object" && input !== null && "auth" in input
              ? (input as { auth: BotSecretView["auth"] }).auth
              : { type: "bearer" },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };

        secrets = [...secrets.filter((secret) => secret.name !== row.name), row];

        return row;
      }
      case "botSecrets/remove": {
        const name = stringField(input, "name");
        const row = secrets.find((secret) => secret.name === name);

        secrets = secrets.map((secret) =>
          secret.name === name ? { ...secret, status: "forgotten" } : secret,
        );

        return { name, removed: row !== undefined };
      }
      case "mcpServers/list":
        return { servers: servers.map(summary) };
      case "mcpServers/get":
        return { server: findServer(stringField(input, "id")) ?? {} };
      case "mcpServers/create": {
        const authorizationUrl = options.authorizationUrl ?? null;
        const server: McpServerDetail = {
          id: `server-${String(servers.length + 1)}`,
          name: stringField(input, "name"),
          url: stringField(input, "url"),
          auth: stringField(input, "auth") === "oauth" ? "oauth" : "none",
          status: authorizationUrl === null ? "ready" : "pending_authorization",
          lastError: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          tools: [
            {
              name: "search",
              description: "Search the fixture corpus.",
              parameters: {},
            } satisfies McpTool,
          ],
        };

        servers = [...servers, server];

        return { server, authorizationUrl };
      }
      case "mcpServers/remove": {
        const id = stringField(input, "id");

        servers = servers.filter((server) => server.id !== id);

        for (const entry of [...liveGrants]) {
          if (entry.startsWith(`${id}:`)) {
            liveGrants.delete(entry);
          }
        }

        return { id };
      }
      case "mcpServers/grants":
        return { grants: liveFor(stringField(input, "id")) };
      case "mcpServers/grant": {
        const id = stringField(input, "id");
        const botId = stringField(input, "botId");

        liveGrants.add(`${id}:${botId}`);

        return { serverId: id, botId };
      }
      case "mcpServers/revoke": {
        const id = stringField(input, "id");
        const botId = stringField(input, "botId");

        liveGrants.delete(`${id}:${botId}`);

        return { serverId: id, botId };
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
    bots,
    usageWindows,

    get preferences() {
      return preferenceView();
    },
    get secrets() {
      return secrets;
    },
    get servers() {
      return servers;
    },
    get grants() {
      return [...liveGrants].map((entry) => {
        const separator = entry.indexOf(":");

        return { botId: entry.slice(separator + 1), revokedAt: null };
      });
    },

    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
