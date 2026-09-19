/**
 * The assembled schema: the single module drizzle-kit diffs, and the module the
 * application reads tables from.
 *
 * Slice 2.1 landed the workflow with no domain tables, so the first migration
 * is the deliberately empty baseline described in `migrations/0000_baseline.sql`.
 * Slice 2.2 added the identity and tenancy tables below and slice 2.3 the runs
 * domain; every migration is generated with `pnpm db:generate`, committed and
 * reviewed, and the conventions around it — `primaryKeyId`, `timestamps`, the
 * status enums, the catalog, constraint and migration suites — apply to every
 * table without being restated.
 */
export { primaryKeyId, timestamps } from "./columns.ts";
export { account, session, user, verification } from "./identity.ts";
export { deploymentSettings, space, spaceMember, spaceMemberRole } from "./tenancy.ts";
export { botSection, bot } from "./bots.ts";
export {
  approvalStatus,
  attemptStatus,
  effectStatus,
  mcpServerAuth,
  mcpServerStatus,
  memoryKind,
  memoryWriteOrigin,
  messageRole,
  notificationKind,
  runStatus,
  taskStatus,
} from "./enums.ts";
export { approval } from "./approvals.ts";
export { encryptedCredential } from "./encrypted-credential.ts";
export { modelConnection } from "./model-connections.ts";
export { event } from "./events.ts";
export { externalEffect } from "./external-effects.ts";
export { botMcpServer, mcpServer, mcpServerTool } from "./mcp.ts";
export { memoryDocument, memoryRevision } from "./memory.ts";
export { notificationPreference } from "./notification.ts";
export { oauthState, webhookDelivery } from "./ingress.ts";
export { message } from "./messages.ts";
export { routine, routineOccurrence } from "./routines.ts";
export { attempt, run } from "./runs.ts";
export { steeringMessage } from "./steering-messages.ts";
export { task } from "./tasks.ts";
export { thread } from "./threads.ts";
