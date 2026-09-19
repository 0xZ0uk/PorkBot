import type { McpGrant, McpServerDetail, McpServerSummary } from "@porkbot/contracts";
import type { McpGrantRecord, McpServerView } from "@porkbot/effect";
import { authenticated } from "../gate.ts";
import type { McpService } from "../services/mcp.ts";

/**
 * The MCP server registry surface (slice 9.5). Every handler is transport
 * translation: the actor and actor-scoped repositories come from the gate, the
 * durable store answers, and the install/callback orchestration lives in the
 * service. No response shape here has a field for a token or a client secret —
 * `credentialName` is deliberately not mapped, so the wire cannot name the row
 * the value lives in.
 */

/**
 * The wire mappers build their objects field by field rather than spreading the
 * record: `credentialName` names the row a token or client secret lives in, so
 * its omission must be a property of this function, not of the serializer
 * stripping unknown keys.
 */
function toSummary(view: McpServerView): McpServerSummary {
  return {
    id: view.id,
    name: view.name,
    url: view.url,
    auth: view.auth,
    status: view.status,
    lastError: view.lastError,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    toolCount: view.tools.length,
  };
}

function toDetail(view: McpServerView): McpServerDetail {
  return {
    id: view.id,
    name: view.name,
    url: view.url,
    auth: view.auth,
    status: view.status,
    lastError: view.lastError,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    tools: [...view.tools],
  };
}

function toGrant(record: McpGrantRecord): McpGrant {
  return {
    botId: record.botId,
    revokedAt: record.revokedAt === null ? null : record.revokedAt.toISOString(),
  };
}

export function createMcpRouter(service: McpService | undefined) {
  const list = authenticated.mcpServers.list.handler(async ({ context }) => ({
    servers: (await context.repositories.mcp.list()).map(toSummary),
  }));

  const get = authenticated.mcpServers.get.handler(async ({ input, context }) => ({
    server: toDetail(await context.repositories.mcp.findById(input.id)),
  }));

  const create = authenticated.mcpServers.create.handler(async ({ input, context }) => {
    if (service === undefined) {
      throw new Error(
        "the MCP service is not configured for this process; supply one in services.mcp",
      );
    }

    const result = await service.install(context.actor, context.repositories, input);

    return { server: toDetail(result.server), authorizationUrl: result.authorizationUrl };
  });

  const remove = authenticated.mcpServers.remove.handler(async ({ input, context }) => {
    // The credential is removed first so it cannot outlive the server it
    // belongs to; the scoped read makes a foreign id a NOT_FOUND before any
    // credential is touched.
    const server = await context.repositories.mcp.findById(input.id);

    await context.repositories.credentials.remove(server.credentialName);
    await context.repositories.mcp.remove(input.id);

    return { id: input.id };
  });

  const grants = authenticated.mcpServers.grants.handler(async ({ input, context }) => {
    await context.repositories.mcp.findById(input.id);

    return {
      grants: (await context.repositories.mcp.listForServer(input.id)).map(toGrant),
    };
  });

  const grant = authenticated.mcpServers.grant.handler(async ({ input, context }) => {
    await context.repositories.mcp.grant(input.botId, input.id);

    return { serverId: input.id, botId: input.botId };
  });

  const revoke = authenticated.mcpServers.revoke.handler(async ({ input, context }) => {
    await context.repositories.mcp.revoke(input.botId, input.id);

    return { serverId: input.id, botId: input.botId };
  });

  return authenticated.mcpServers.router({ list, get, create, remove, grants, grant, revoke });
}
