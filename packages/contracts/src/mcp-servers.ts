import { z } from "zod";
import { MCP_AUTH_MODES, MCP_SERVER_STATUSES } from "@porkbot/core";
import { authenticatedProcedure } from "./access.ts";

/**
 * The MCP server registry surface (slice 9.5, PRD story 38; epic E9).
 *
 * Install a server by URL, read back what discovery found, attach it to bots
 * and revoke it. The shapes deliberately have no field for a token, a client
 * secret or their ciphertext: the credential lives in the encrypted store, and
 * "a response never carries a secret" is a property of the schema rather than a
 * promise about a handler.
 *
 * The OAuth start returns the URL the browser is sent to; the callback itself
 * is a plain HTTP route in the API (it arrives before any session), not an RPC
 * procedure. Every input names a bot or a server by id and never a space: the
 * actor's scope comes from the session.
 */

export const mcpAuthModeSchema = z.enum(MCP_AUTH_MODES);
export const mcpServerStatusSchema = z.enum(MCP_SERVER_STATUSES);

export const mcpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** The server's JSON Schema for the tool's arguments, unchanged. */
  parameters: z.unknown(),
});

export type McpTool = z.infer<typeof mcpToolSchema>;

const serverFields = {
  id: z.string().min(1),
  name: z.string(),
  url: z.string(),
  auth: mcpAuthModeSchema,
  status: mcpServerStatusSchema,
  /** An operator-safe line from the last failed install or discovery. */
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const mcpServerSummarySchema = z.object({
  ...serverFields,
  toolCount: z.number().int().min(0),
});

export const mcpServerDetailSchema = z.object({
  ...serverFields,
  tools: z.array(mcpToolSchema),
});

export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>;
export type McpServerDetail = z.infer<typeof mcpServerDetailSchema>;

export const mcpGrantSchema = z.object({
  botId: z.uuid(),
  /** `null` while the grant is live; the revoke time once it is not. */
  revokedAt: z.iso.datetime().nullable(),
});

export type McpGrant = z.infer<typeof mcpGrantSchema>;

export const mcpServersListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/mcp/servers",
    operationId: "mcpServersList",
    summary: "Installed MCP servers for this operator, without their tools",
  })
  .output(z.object({ servers: z.array(mcpServerSummarySchema) }));

export const mcpServersGetContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/mcp/servers/{id}",
    operationId: "mcpServersGet",
    summary: "One installed MCP server with the tools discovery persisted",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: { status: 404, message: "No such MCP server in this space" },
  })
  .output(z.object({ server: mcpServerDetailSchema }));

export const mcpServersCreateContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/mcp/servers",
    operationId: "mcpServersCreate",
    summary: "Install an MCP server by URL; OAuth servers return the consent URL",
  })
  .input(
    z
      .object({
        name: z.string().min(1).max(120),
        url: z.url().max(2_048),
        auth: mcpAuthModeSchema,
        /** The OAuth client this deployment registered with the server. */
        clientId: z.string().max(200).optional(),
        /**
         * The client secret, when the server requires one. It is encrypted on
         * the way in and never returned, echoed or listed.
         */
        clientSecret: z.string().max(2_000).optional(),
      })
      .refine((input) => input.auth === "none" || input.clientId !== undefined, {
        message: "an OAuth server needs the clientId this deployment registered",
        path: ["clientId"],
      }),
  )
  .errors({
    BAD_REQUEST: {
      status: 400,
      message: "The server URL is not an allowed destination",
    },
    CONFLICT: { status: 409, message: "An MCP server with that name already exists" },
    SERVICE_UNAVAILABLE: { status: 503, message: "The MCP server could not be reached" },
  })
  .output(z.object({ server: mcpServerDetailSchema, authorizationUrl: z.string().nullable() }));

export const mcpServersRemoveContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/mcp/servers/{id}",
    operationId: "mcpServersRemove",
    summary: "Uninstall an MCP server, its tools, its grants and its credential",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: { status: 404, message: "No such MCP server in this space" },
  })
  .output(z.object({ id: z.string().min(1) }));

export const mcpServersGrantsContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/mcp/servers/{id}/grants",
    operationId: "mcpServersGrants",
    summary: "The bots this server is granted to, including revoked grants",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: { status: 404, message: "No such MCP server in this space" },
  })
  .output(z.object({ grants: z.array(mcpGrantSchema) }));

export const mcpServersGrantContract = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/mcp/servers/{id}/bots/{botId}",
    operationId: "mcpServersGrant",
    summary: "Grant an installed MCP server to one bot",
  })
  .input(z.object({ id: z.string().min(1), botId: z.uuid() }))
  .errors({
    NOT_FOUND: { status: 404, message: "No such bot or MCP server in this space" },
  })
  .output(z.object({ serverId: z.string().min(1), botId: z.uuid() }));

export const mcpServersRevokeContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/mcp/servers/{id}/bots/{botId}",
    operationId: "mcpServersRevoke",
    summary: "Revoke one bot's grant; a live run loses the tools on its next call",
  })
  .input(z.object({ id: z.string().min(1), botId: z.uuid() }))
  .errors({
    NOT_FOUND: { status: 404, message: "No such bot or MCP server in this space" },
  })
  .output(z.object({ serverId: z.string().min(1), botId: z.uuid() }));
