export const moduleInfo = {
  name: "@porkbot/contracts",
  summary:
    "Schemas and transport types. The single source of transport truth: procedures, their typed errors, and the client type derived from the contract.",
} as const;

// The contract tree: input and output schemas for every procedure. The API
// implements this object and no other package may declare a transport type of
// its own (PRD decisions 14 and 15).
export { appContract, publicProcedures } from "./contract.ts";
export type { AppContract } from "./contract.ts";

// Access: authenticated by default, public only when a contract says so. The
// gate in the API reads this metadata; `access.test.ts` walks the tree and
// fails when a procedure carries no marker or the public list drifts.
export {
  authenticatedProcedure,
  procedureAccessSchema,
  publicProcedure,
  rateLimitedDataSchema,
  rateLimitedErrorMessage,
} from "./access.ts";
export type { ProcedureAccess, ProcedureMeta, RateLimitedData } from "./access.ts";

export { deploymentStatusContract, signupAvailabilitySchema } from "./deployment.ts";
export type { SignupAvailability } from "./deployment.ts";

export { accountMeContract, memberRoleSchema } from "./account.ts";
export type { MemberRole } from "./account.ts";

// A bot's computer (slices 7.1 and 7.5, PRD decision 20; stories 27, 29 and
// 30): the operator's reach into the supervisor's lifecycle, scoped by bot id,
// and the snapshot surface that makes a bad state recoverable. The state
// vocabulary mirrors `@porkbot/adapter-kit` and a test pins the two; a snapshot
// view names the row, never the storage key.
export {
  computersBootContract,
  computersRecoverContract,
  computersResetContract,
  computersRestoreContract,
  computersSnapshotContract,
  computersSnapshotsContract,
  computersStatusContract,
  computersStopContract,
  computerSnapshotViewSchema,
  computerStateSchema,
  computerViewSchema,
} from "./computers.ts";
export type { ComputerSnapshotView, ComputerStateView, ComputerView } from "./computers.ts";

// Notification preferences (slice 8.6, PRD decision 33; story 35): the
// operator's switches over `@porkbot/core`'s event vocabulary. The output is
// every kind with the quiet defaults filled in, so a settings surface renders
// the set as given and never infers an absent kind.
export {
  notificationKindSchema,
  notificationPreferenceSchema,
  notificationPreferencesSchema,
  notificationsPreferencesContract,
  notificationsSetPreferenceContract,
} from "./notifications.ts";
export type { NotificationPreference, NotificationPreferencesView } from "./notifications.ts";

export {
  avatarContentTypes,
  botAvatarUploadSchema,
  botListScopeSchema,
  botSchema,
  botSectionSchema,
  botsArchiveContract,
  botsAvatarContract,
  botsClearAvatarContract,
  botsCreateContract,
  botsDeleteContract,
  botsGetContract,
  botsListContract,
  botsRestoreContract,
  botsSetAvatarContract,
  botsUpdateContract,
  maxAvatarBase64Length,
  maxAvatarBytes,
} from "./bots.ts";
export type { AvatarContentType, Bot, BotSection } from "./bots.ts";

export {
  sectionsCreateContract,
  sectionsDeleteContract,
  sectionsListContract,
  sectionsUpdateContract,
} from "./sections.ts";

// The routine authoring surface (slice 8.5, PRD decision 22): the operator's
// list, create, edit, pause and tombstone, the next-fire preview, the manual
// test run and the outcome history the editor renders.
export {
  routineOutcomeSchema,
  routineOutcomeStatusSchema,
  routineSchema,
  routinesCreateContract,
  routinesListContract,
  routinesOutcomesContract,
  routinesPreviewContract,
  routinesRemoveContract,
  routinesTestRunContract,
  routinesUpdateContract,
} from "./routines.ts";
export type { Routine, RoutineOutcome, RoutineOutcomeStatus } from "./routines.ts";

// The operator's memory surface (slice 8.3, PRD decision 21; stories 23 and
// 24): live and deleted documents, whole revision history, deliberate writes
// and restoring a recorded revision. The outcome union is the transport shape
// of a memory decision — a change with its revision, a no-op, or the domain
// rule a refusal broke — so the client renders exactly what the store decided.
export {
  memoryDocumentSchema,
  memoryKindSchema,
  memoryListContract,
  memoryListScopeSchema,
  memoryRemoveContract,
  memoryRestoreContract,
  memoryRevisionsContract,
  memoryRevisionSchema,
  memoryUpdateContract,
  memoryWriteOriginSchema,
  memoryWriteOutcomeSchema,
} from "./memory.ts";
export type { MemoryDocumentView, MemoryRevisionView, MemoryWriteOutcomeView } from "./memory.ts";

// Token usage (slice 8.8, PRD story 34): one bot's all-time totals and its
// daily buckets. Every token figure is nullable and a null is "not reported",
// so a provider that stayed silent is never rendered as a zero. This is a
// display surface only — recorded and displayed, not charged (PRD #183), with
// no budget or plan field a client could mistake for enforcement.
export { usageBotContract, usageBotSchema, usagePeriodSchema, usageTotalsSchema } from "./usage.ts";
export type { UsageBot, UsagePeriodView, UsageTotalsView } from "./usage.ts";

export {
  defaultMessagePageSize,
  defaultThreadPageSize,
  maxPageSize,
  messageBlockSchema,
  messageRoleSchema,
  messageSchema,
  runEventSchema,
  threadCursorSchema,
  threadSchema,
  threadsClearContract,
  threadsCreateContract,
  threadsEventsContract,
  threadsListContract,
  threadsMessagesContract,
  threadsSendContract,
  threadsToolResultContract,
} from "./threads.ts";
export type { Message, RunEventMessage, Thread, ThreadCursor } from "./threads.ts";

// Run control (slice 6.7, story 21) and the liveness read (slice 6.10, story
// 22): the operator's one write into a single run, and the assessment of what
// it is doing. A stop is recorded as a durable request the worker's live
// session observes, so the cancellation keeps the session's event sequence and
// lease release; the answer is the run's state, and a finished run answers it
// too. `get` answers the persisted liveness the console renders and the
// notification path consumes.
export {
  runsGetContract,
  runsStopContract,
  runGetSchema,
  runLivenessSchema,
  runLivenessStateSchema,
  runStatusSchema,
  runStopSchema,
} from "./runs.ts";
export type { RunGet, RunLiveness, RunStop } from "./runs.ts";

// Stored credentials (slices 9.1 and 9.2, PRD decision 10; stories 14 and 15):
// the list surface answers masked summaries only and `store` takes a value in
// and answers a mask back. No output schema has a field for a value, so "no
// endpoint returns a full secret" is a property of the contract rather than a
// promise about a handler.
export {
  credentialSchema,
  credentialsListContract,
  credentialsStoreContract,
} from "./credentials.ts";
export type { Credential } from "./credentials.ts";

// Model connections (slice 9.2, PRD decisions 12, 13 and 19; stories 12 and
// 13): an OpenAI-compatible endpoint by URL and credential name, a real probe
// and the per-space default. The key travels only through `credentials.store`.
export {
  credentialNameSchema,
  modelBaseUrlSchema,
  modelConnectionSchema,
  modelConnectionsCreateContract,
  modelConnectionsListContract,
  modelConnectionsProbeContract,
  modelConnectionsRemoveContract,
  modelConnectionsSetDefaultContract,
  modelConnectionsUpdateContract,
  modelDescriptorSchema,
  modelFailureKindSchema,
  modelProbeSchema,
} from "./model-connections.ts";
export type { ModelConnection, ModelFailureKind, ModelProbe } from "./model-connections.ts";

// MCP servers (slice 9.5, PRD story 38): install by URL, read back discovery,
// grant to bots and revoke. The output schemas have no field for a token or a
// client secret, so "a response never carries a server credential" is a
// property of the wire shape rather than a promise about a handler.
export {
  mcpAuthModeSchema,
  mcpGrantSchema,
  mcpServerDetailSchema,
  mcpServerStatusSchema,
  mcpServersCreateContract,
  mcpServersGetContract,
  mcpServersGrantContract,
  mcpServersGrantsContract,
  mcpServersListContract,
  mcpServersRemoveContract,
  mcpServersRevokeContract,
  mcpServerSummarySchema,
  mcpToolSchema,
} from "./mcp-servers.ts";
export type { McpGrant, McpServerDetail, McpServerSummary, McpTool } from "./mcp-servers.ts";

// The client: a type derived from the contract plus the factory that builds it.
export { createApiClient } from "./client.ts";
export type { ApiClientOptions, AppClient } from "./client.ts";

// The client half of a resumable subscription (slice 4.3): consume
// `threads.events` and reconnect from the last signed cursor with the core
// backoff policy, so a dropped connection resumes instead of refetching.
export { subscribeThreadEvents } from "./stream.ts";
export type {
  ThreadEventsCallOptions,
  ThreadEventsInput,
  ThreadEventsProcedure,
  ThreadSubscriptionOptions,
  ThreadSubscriptionState,
} from "./stream.ts";

// The error envelope: the oRPC class the boundary mapping in @porkbot/effect
// constructs, re-exported so no other package imports the transport library.
export { ORPCError } from "./errors.ts";
