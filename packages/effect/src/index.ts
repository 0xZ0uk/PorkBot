export const moduleInfo = {
  name: "@porkbot/effect",
  summary: "Shared Effect layers, service tags, typed errors and the transport error mapping.",
} as const;

// The typed errors the `Cause -> ORPCError` table maps. They are declared here,
// not beside their throw sites, so the mapping can name them without importing
// `@porkbot/db` (the module map keeps that edge out of this package). Every
// class is an Effect `Data.TaggedError`: throwable from promise code, catchable
// by tag in an Effect program, and keyable in the mapping table.
export {
  ApprovalStoreError,
  BlockedUrlError,
  BotSecretDestinationError,
  ComputerUnavailableError,
  CredentialMissingError,
  CredentialStoreError,
  CursorRejectedError,
  DeploymentSettingsConflictError,
  GateTimeoutError,
  InvalidComputerPathError,
  InvalidMessageError,
  InvalidOAuthStateError,
  InvalidRoutineScheduleError,
  InvalidToolCallError,
  LeaseLostError,
  McpServerUnavailableError,
  MessageNonceReusedError,
  NameConflictError,
  NotFoundError,
  RunGoneError,
  RunNotActiveError,
  ToolCallConflictError,
  ToolLedgerError,
  UnknownToolError,
} from "./errors.ts";
export type {
  BlockedUrlReason,
  CredentialStoreFailure,
  CursorRejection,
  InvalidMessageReason,
  OAuthCallbackRejection,
  RoutineScheduleRejection,
  TypedError,
  TypedErrorTag,
} from "./errors.ts";

// The transport boundary (PRD decision 28): one table from every typed error to
// an oRPC code, one default row for an unmapped defect, and the mapping from an
// Effect `Cause`. Routers throw typed errors and never inspect one; the gate
// middleware calls `mapError`, and the API's error listener reads
// `boundaryReports` to decide what a redacted log line contains.
export { boundaryReports, errorMappings, mapCause, mapError, mappingFor } from "./mapping.ts";
export type {
  BoundaryError,
  BoundaryOptions,
  DeclaredError,
  DeclaredErrorLookup,
  ErrorMapping,
  MappedErrorCode,
} from "./mapping.ts";

// Layer lifetimes (PRD decision 27): process-scoped services are declared with
// `processTag` and only `processSingleton` can bless a boot-time singleton, so
// a request-scoped repository cannot be baked into one.
export { processSingleton, processTag, requestScoped, requestTag } from "./lifetimes.ts";
export type {
  LayerLifetime,
  ProcessLayer,
  ProcessScoped,
  ProcessTag,
  RequestLayer,
  RequestScoped,
  RequestTag,
} from "./lifetimes.ts";

// The duplex run seam (slice 5.2, PRD decision 13): a `RunSession`'s events
// stream and commands mailbox, the run-scoped `AgentRuntime` layer that
// provides one session, and the process-scoped `LiveRuns` registry that routes
// operator commands to the live run or answers `RunGoneError`. The vendor
// implementation (Pi) lives in @porkbot/adapters; nothing here names a vendor.
export { AgentRuntime, fenced, LiveRuns, liveRunsLayer, withLiveRun } from "./agent-runtime.ts";
export type {
  AgentRuntimeFailure,
  AgentRuntimeLayer,
  AgentRuntimeShape,
  AgentRuntimeTag,
  LiveRunsShape,
  LiveRunsTag,
  RunCommand,
  RunSession,
  RunStartRequest,
} from "./agent-runtime.ts";

// The cross-process command path into a live run (slice 6.7, stories 20 and
// 21). A `RunSession` mailbox is process-local, so a steer is the durable
// `steering_message` row the send wrote and a stop is the run row's
// `stop_requested_at` mark; `RunCommandSource` is the read seam `@porkbot/db`
// implements, `pumpRunCommands` forwards what it claims into the session, and
// `consumeRunSession` drains the events once and reports the terminal outcome
// the executor settles the row from.
export {
  consumeRunSession,
  DEFAULT_STOP_REASON,
  pumpRunCommands,
  RUN_COMMAND_POLL_INTERVAL_MS,
} from "./run-commands.ts";
export type {
  PendingSteer,
  RunCommandPumpOptions,
  RunCommandSource,
  RunSessionOutcome,
} from "./run-commands.ts";

// The durable approval gate (slice 5.7, PRD decision 13; audit P0 item 1).
// Approval is pending state, not a live socket: `open` records the durable row
// (reopening the same one after a restart), `waitFor` polls that row until an
// operator decision or the deadline settles it, and a timeout is the typed
// `GateTimeoutError` the run answers as a deny. The store is a seam
// `@porkbot/db` implements over the `approval` rows; `ApprovalDecisions` is the
// operator's half the API records votes through; this package declares both.
export { createApprovalGate } from "./approval-gate.ts";
export type {
  ApprovalDecisions,
  ApprovalGateError,
  ApprovalGateOptions,
  ApprovalGateShape,
  ApprovalHistoryRecord,
  ApprovalListInput,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStore,
  ApprovalVoteInput,
  ApprovalVoteResult,
} from "./approval-gate.ts";

// The fenced run lifetime (slice 6.3, PRD decisions 1, 25 and 26): heartbeat
// on an interval, and interrupt the run's whole fiber tree the moment a beat
// cannot be renewed, so a superseded owner cancels its work instead of
// committing a side effect the next owner already owns. The beat is an Effect
// the caller supplies, so this package names no data layer.
export { withRunFence } from "./run-fence.ts";
export type { RunFenceOptions } from "./run-fence.ts";

// The computer tools (slice 6.9, PRD decisions 20 and 30; stories 27–30). A
// run reaches its machine through five registrations — shell, file read/write,
// listing and browser — and every one is a command through the fenced runner,
// so the offline emulator and the real Docker provider serve the same tool
// code. The computer is bound at construction and never chosen by the model;
// file bytes, shell stdout and browser text are labelled `UntrustedContent` at
// this boundary before they can reach a prompt.
export {
  COMPUTER_TOOL_NAMES,
  createComputerTools,
  MAX_COMPUTER_OUTPUT_BYTES,
  MAX_COMPUTER_PATH_LENGTH,
  MAX_FILE_WRITE_BYTES,
  MAX_SHELL_COMMAND_LENGTH,
  quoteShellArgument,
} from "./computer-tools.ts";
export type { ComputerToolOptions } from "./computer-tools.ts";

// The artifact seam (slice 7.6, story 33). A tool that produces a file hands
// the bytes through one door, and the implementation — storage plus the run's
// file store — answers the pointer a tool result and a download link carry.
// The tool layer never learns a storage key or a space; the path every stored
// file is downloaded from is derived from its id, never from its location.
export { fileDownloadPath } from "./artifact-recorder.ts";
export type {
  ArtifactRecorder,
  ArtifactRecordRequest,
  RecordedArtifact,
} from "./artifact-recorder.ts";

// The chunked file writer (slice 7.6, story 32). The provider seam serves
// files through `exec` alone, so this writer streams an async body into a
// machine as a sequence of fenced part writes and one assembly, bounded by the
// part size rather than by the file. The worker's materialization uses it to
// place a message's attachments; the tools keep their own write path.
export { COMPUTER_FILE_CHUNK_BYTES, createComputerFileWriter } from "./computer-file-transfer.ts";
export type {
  ComputerFileWriteRequest,
  ComputerFileWriter,
  ComputerFileWriterOptions,
} from "./computer-file-transfer.ts";

// The fenced computer command runner (slice 7.4, PRD decision 26). The
// provider seam carries no fence, so this layer holds the run's own
// `(runId, owner, fence)` on a durable computer lease around every command:
// a reclaimed run's in-flight command cannot renew or commit, a retried
// command with the same `callId` replays instead of repeating its effect, and
// a lease held live by another run is the classified `ComputerLeaseHeldError`
// rather than a provider timeout. The constructor is the one place the
// computer TTL is asserted not to outlive the run TTL; `@porkbot/db`
// implements the store over the computer-lease rows.
export {
  ComputerCommandFailedError,
  ComputerLeaseHeldError,
  ComputerLeaseTtlError,
  createFencedComputerCommands,
} from "./computer-commands.ts";
export type {
  ComputerCommandRequest,
  ComputerCommandRunner,
  ComputerLease,
  ComputerLeaseAcquisition,
  ComputerLeaseHolder,
  ComputerLeaseStore,
  FencedComputerCommandsOptions,
} from "./computer-commands.ts";

// Tool dispatch (slice 5.5, PRD decision 26; audit section 3). One registration
// carries a tool's metadata and its handler, so the list the model sees is
// generated from the same value `execute` dispatches and cannot drift. Every
// call is keyed by its durable `callId`, claimed in a ledger before the side
// effect and replayed on retry; the caller's fenced heartbeat runs before the
// handler, and the run lease TTL must cover every tool's declared duration.
// The database implementation of `ToolCallLedger` lives in `@porkbot/db` over
// the `external_effect` rows; this package declares the seam.
export { createToolDispatcher, ToolRegistrationError } from "./tool-dispatcher.ts";
export type {
  ToolCall,
  ToolCallAdmission,
  ToolCallLedger,
  ToolDispatchError,
  ToolDispatcher,
  ToolDispatcherOptions,
  ToolOutcome,
  ToolRegistration,
  ToolRegistrationErrorReason,
} from "./tool-dispatcher.ts";

// The event stream's durable and live halves (slice 5.6): `RunEventSink` is
// the append-only write seam `@porkbot/db` implements over the `event` table,
// and `createRunEventRecorder` is the one transform that redacts tool
// arguments, points an oversized result at its artifact and stamps a call's
// duration. Running every event through the recorder before it is persisted
// or streamed is what keeps the live timeline and the replayed one identical.
export { createRunEventRecorder } from "./run-events.ts";
export type { RunEventRecorder, RunEventRecorderOptions, RunEventSink } from "./run-events.ts";

// The usage seam (slice 8.8, PRD story 34). A run's adapters report what each
// completed model turn spent; `createUsageStore` in `@porkbot/db` implements
// the recorder over the usage rows, and the operator's read half
// aggregates it per bot and per day. Null token fields are "not reported":
// v1.0 records and displays usage and never charges or gates on it.
export { reportUsage } from "./usage.ts";
export type { RunUsage, UsageRecorder } from "./usage.ts";

// The durable half of memory (slice 8.1, PRD decision 21). Documents and
// revisions live in Postgres; the provider seam in `@porkbot/adapter-kit` is
// only an index over them. `createMemoryStore` in `@porkbot/db` implements
// these interfaces in one module — the only module that names the memory
// tables — and the factory splits by actor: an operator writes deliberately
// and reads history, an agent proposes create-or-rewrite and can never delete.
export type {
  MemoryDocumentRecord,
  MemoryDocuments,
  MemoryProposals,
  MemoryReader,
  MemoryRevisionRecord,
  MemoryWriteInput,
  MemoryWriteOutcome,
} from "./memory-store.ts";

// The two-lane context policy (slice 8.2, PRD decision 21; stories 23 and 24).
// The agent's `remember`, `recall` and `forget` tools are registrations built
// over the proposal half of the store and the recall index, so every write is
// an agent proposal the operator can see and every recall is bounded. The
// compactor shortens the conversation lane through the model runtime while the
// memory lane is read fresh and asserted preserved, and `loadRunPrompt` pairs
// the scoped memory read with core's composer so a run's prompt has one path.
export { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory-tools.ts";
export type { MemoryToolOptions } from "./memory-tools.ts";
export { createConversationCompactor, CompactionFailure } from "./conversation-compactor.ts";
export type {
  CompactionFailureReason,
  CompactionInput,
  CompactionOutcome,
  ConversationCompactor,
  ConversationCompactorOptions,
} from "./conversation-compactor.ts";
export { loadRunPrompt } from "./run-context.ts";
export type { LoadRunPromptInput } from "./run-context.ts";

// The durable half and the delivery path of operator notifications (slice 8.6,
// PRD decision 33; stories 35). Preferences are per operator with quiet
// defaults from `@porkbot/core`; the eligibility read joins the space
// membership, so a notification cannot cross a space and a non-member is
// suppressed rather than notified. `createNotificationDelivery` retries the
// transient provider failures with core's backoff and surfaces the permanent
// ones as an outcome the caller holds — an undelivered notification is an
// error line, never a silent drop. The store seams are implemented in
// `@porkbot/db`; the provider is the adapter-kit seam, so the offline emulator
// exercises this path with no key and no network.
export type {
  NotificationEligibility,
  NotificationPreferences,
  NotificationRecipients,
} from "./notification-store.ts";
export { createNotificationDelivery } from "./notification-delivery.ts";
export type {
  NotificationDelivery,
  NotificationDeliveryOptions,
  NotificationDeliveryOutcome,
  NotificationDeliveryRequest,
  NotificationSuppressionReason,
} from "./notification-delivery.ts";

// The durable half of stored credentials (slice 9.1, PRD decision 10; stories
// 14 and 15). The seam extends adapter-kit's `CredentialStore`, so the one
// object `@porkbot/db` builds over the encrypted rows is both what a provider
// resolves a key through and what the operator's list rotates. It carries
// summaries and never values; the store raises the typed
// `CredentialStoreError` when its keyring cannot unlock a row.
export type { CredentialRotation, CredentialSummary, Credentials } from "./credential-store.ts";

// MCP servers (slice 9.5, PRD story 38). The durable seams `@porkbot/db`
// implements over the server, tool and grant rows; the credential codec the
// install and callback paths share; and the tool factory that turns a granted
// server's discovered tools into dispatcher registrations. Every registration
// re-asks the grant before each call, so a revoke stops the next call rather
// than the next run, and every result is labelled `mcp_output` as it enters the
// prompt.
export type {
  McpAuthMode,
  McpGrantRecord,
  McpGrantedServer,
  McpRunServers,
  McpServerRecord,
  McpServerStatus,
  McpServers,
  McpServerView,
  McpToolRecord,
  NewMcpServer,
} from "./mcp-store.ts";
export { parseMcpCredential, serializeMcpCredential } from "./mcp-credentials.ts";
export type { McpCredential } from "./mcp-credentials.ts";
export {
  createMcpTools,
  DEFAULT_MCP_TOOL_DURATION_MS,
  MAX_MCP_TOOL_NAME_LENGTH,
  McpGrantRevokedError,
  mcpToolName,
} from "./mcp-tools.ts";
export type { McpToolOptions, McpToolServer } from "./mcp-tools.ts";

// URL safety (slice 4.6, PRD decision 23). Every fetch of a user-supplied URL
// enters through `safeFetch`; the rules, the guarded lookup and the typed
// refusal live here so there is no second policy to drift from.
export {
  assertAllowedUrl,
  BLOCKED_ADDRESS_RULES,
  createGuardedLookup,
  createSafeFetch,
  isBlockedAddress,
  safeFetch,
} from "./url-safety.ts";
export type {
  BlockedAddressRule,
  GuardedLookup,
  ResolveHost,
  ResolvedAddress,
  SafeFetch,
  SafeFetchBody,
  SafeFetchInit,
  UrlSafetyOptions,
} from "./url-safety.ts";

// Webhook signature verification (slice 4.5, PRD decision 24). The ingress
// calls this over the raw body before anything parses it, so an unsigned or
// wrongly-signed request never reaches a handler, and the digest comparison is
// constant-time and tolerates any length.
export {
  defaultSignatureToleranceSeconds,
  parseWebhookSignature,
  signWebhookBody,
  timingSafeEqualBytes,
  verifyWebhookSignature,
  webhookDeliveryHeader,
  webhookSignatureHeader,
} from "./webhook-signature.ts";
export type {
  ParsedWebhookSignature,
  SignWebhookInput,
  VerifyWebhookSignatureInput,
  WebhookSignatureCheck,
  WebhookSignatureFailure,
} from "./webhook-signature.ts";

// Screen capabilities (slice 7.1, PRD decision 20). The reserved frames and
// input paths are v1.1, but their access rule ships now: a bearer token is
// HMAC-signed, bound to one computer and one actor, and expires within a
// bounded lifetime, so the supervisor can verify a screen request without a
// session store and an API process can mint one without holding provider
// credentials. An unconfigured key refuses every screen request, which is the
// correct v1.0 posture.
export {
  createScreenCapabilityCodec,
  DEFAULT_SCREEN_CAPABILITY_TTL_SECONDS,
  MAX_SCREEN_CAPABILITY_LENGTH,
  MAX_SCREEN_CAPABILITY_TTL_SECONDS,
} from "./screen-capability.ts";
export type {
  ScreenCapabilityBinding,
  ScreenCapabilityCheck,
  ScreenCapabilityCodec,
  ScreenCapabilityCodecOptions,
  ScreenCapabilityExpectation,
  ScreenCapabilityRejection,
} from "./screen-capability.ts";

// Proxy capabilities (slice 7.8, PRD decision 29; audit P1 item 7). The token a
// sandboxed command holds in place of a credential: HMAC-signed, bound to one
// run and one computer, expired within a bounded lifetime, and verified by the
// computer's proxy alone. It is a capability, not a credential — it names no
// upstream and carries no key — and settling the run removes the grant the
// token points at, so an unexpired token is still dead past its run's end.
export {
  createProxyCapabilityCodec,
  DEFAULT_PROXY_CAPABILITY_TTL_SECONDS,
  MAX_PROXY_CAPABILITY_LENGTH,
  MAX_PROXY_CAPABILITY_TTL_SECONDS,
} from "./proxy-capability.ts";
export type {
  ProxyCapabilityBinding,
  ProxyCapabilityCheck,
  ProxyCapabilityCodec,
  ProxyCapabilityCodecOptions,
  ProxyCapabilityExpectation,
  ProxyCapabilityRejection,
} from "./proxy-capability.ts";

// The run-scoped grant (slice 7.8, PRD decision 29): the composition that
// resolves a run's credentials server-side, writes them into the computer's
// proxy and gives the run's commands a capability instead. A provider without
// a proxy is a typed `not_found`; a missing credential never reaches a log
// line; and revoking the grant is the run's settle path, not a sweep.
export {
  createRunCredentialProxy,
  RUN_PROXY_TOKEN_ENV,
  RUN_PROXY_URL_ENV,
  RunProxyCredentialError,
  RunProxyUnavailableError,
} from "./run-credential-proxy.ts";
export type {
  BotSecretGrantResult,
  BotSecretUpstreams,
  OpenRunCredentialProxyRequest,
  RunCredentialProxy,
  RunCredentialProxyHandle,
  RunCredentialProxyOptions,
  RunProxyUpstreamPlan,
} from "./run-credential-proxy.ts";

// Bot secrets (slice 9.6, E9 epic; reference parity BotSecret and
// `request_secret` / `list_secrets` / `forget_secret`). The durable rows'
// actor-scoped seams, cut so the run's half has no method that returns a
// value; the one resolver that does is called only by the run's proxy
// composition; and the tool factory the model is offered, which gates every
// ask and grows the run's proxy by the approved name.
export type {
  BotSecretReader,
  BotSecretRequests,
  BotSecretResolver,
  BotSecrets,
  BotSecretSummary,
  BotSecretValue,
} from "./bot-secrets.ts";
export {
  BOT_SECRET_TOOL_NAMES,
  createBotSecretTools,
  DEFAULT_BOT_SECRET_TOOL_DURATION_MS,
  MAX_SECRET_TOOL_NAME_LENGTH,
} from "./bot-secret-tools.ts";
export type { BotSecretToolOptions } from "./bot-secret-tools.ts";

// Untrusted ingestion, egress and dangerous actions (slices 10.1 and 10.2,
// PRD decision 30; story 40). The danger guard is the policy's enforcement
// edge: `@porkbot/core` owns the register of dangerous classes, and a flagged
// call records a durable approval and waits on the row, while a deadline that
// passes denies rather than hangs. The web tools are the model's one door to
// the web, so they guard the fetch through it, label the page through the
// ingestion boundary and keep it out of the instruction channel.
export { actionRefusalResult, createDangerousActionGuard } from "./danger-guard.ts";
export type {
  ActionAuthorization,
  DangerousActionGuardOptions,
  DangerousActionGuardShape,
} from "./danger-guard.ts";
export {
  createWebTools,
  MAX_WEB_BYTES,
  MAX_WEB_QUERY_LENGTH,
  MAX_WEB_SEARCH_RESULTS,
  MAX_WEB_URL_LENGTH,
  WEB_TOOL_NAMES,
} from "./web-tools.ts";
export type { WebToolOptions } from "./web-tools.ts";
