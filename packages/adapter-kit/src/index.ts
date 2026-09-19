export const moduleInfo = {
  name: "@porkbot/adapter-kit",
  summary:
    "Provider interfaces, the shared failure vocabulary and the two-implementations plan. No implementations.",
} as const;

// The shared failure vocabulary (slice 5.1). Every adapter translates its own
// errors into these five kinds before a failure crosses the seam, and lifecycle
// code branches on the kind rather than on a provider's error string.
export { isProviderFailure, PROVIDER_FAILURE_KINDS } from "./failures.ts";
export type { FailureMapping, ProviderFailure, ProviderFailureKind } from "./failures.ts";

// The transactional mail seam: password reset and verification depend on this,
// so the auth gate names no SMTP client and no vendor (PRD module map). The
// implementations and the offline mailbox emulator live in @porkbot/adapters
// (slice 3.5).
export type {
  TransactionalEmailMessage,
  TransactionalEmailProvider,
  TransactionalEmailReceipt,
} from "./mail.ts";

// The credential seam every provider implementation resolves its secrets
// through (slice 3.5). Declared here, implemented in @porkbot/adapters, so a
// provider's key is never a hard-coded environment read in provider code.
export type { CredentialStore } from "./credentials.ts";

// The computer seam (slices 6.9, 7.2, 7.3): shell, files, browser, snapshots,
// with `frames()`/`input()` reserved for v1.1 screen work.
export type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerFrame,
  ComputerInput,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerState,
  ComputerStatus,
} from "./computer.ts";
export { COMPUTER_STATES, snapshotChecksumPattern } from "./computer.ts";

// The model runtime seam (slices 5.4, 9.2): the agent loop talks to an
// OpenAI-compatible endpoint through this interface, hosted or self-hosted,
// with the key resolved by name through the credential store.
export type {
  ModelConnection,
  ModelDescriptor,
  ModelMessage,
  ModelProbeResult,
  ModelRuntimeProvider,
  ModelStreamEvent,
  ModelToolDefinition,
  ModelTurnRequest,
} from "./model-runtime.ts";

// The MCP server seam (slice 9.5, PRD story 38): install a server by URL,
// discover the tools it advertises, call one, and complete the OAuth code
// exchange when the server requires it. Every implementation dials through the
// URL-safety module; tokens are passed per request, never read from the
// environment. The offline emulator and the real HTTP provider live in
// @porkbot/adapters.
export type {
  McpAuthorizationRequest,
  McpCallRequest,
  McpCallResult,
  McpCodeExchangeRequest,
  McpDiscoverRequest,
  McpOAuthTokens,
  McpServerDescription,
  McpServerProvider,
  McpToolDescriptor,
} from "./mcp.ts";
export { failureMapping as mcpFailureMapping } from "./mcp.ts";

// The memory retrieval seam (slice 8.1): durable documents live in Postgres
// with their revisions, and this interface indexes them for recall.
export type {
  MemoryEntry,
  MemoryMatch,
  MemoryProvider,
  MemorySearchMode,
  MemorySearchRequest,
} from "./memory.ts";

// The notification seam (slice 8.6): preferences decide what is worth
// interrupting for, the provider only delivers.
export type {
  NotificationProvider,
  NotificationReceipt,
  OperatorNotification,
} from "./notification.ts";

// The realtime fanout seam (slices 4.3, 6.1): the wake-up that tells a
// subscriber there are persisted events past its cursor, never the payload.
export type { RealtimeFanout, ThreadSignal } from "./realtime.ts";

// The storage seam (slice 7.7): bot homes, attachments, artifacts and backups,
// local by default and S3-compatible where the deployment has object storage.
export type { StorageBody, StorageObject, StorageProvider, StoragePutRequest } from "./storage.ts";

// The home-sync story per computer provider (slice 7.7): every planned
// provider either routes a home's bytes through the storage seam or is
// explicitly not backed up, and home-sync.test.ts fails when one is silent.
export { COMPUTER_HOME_SYNC } from "./home-sync.ts";
export type { ComputerHomeSyncStory } from "./home-sync.ts";

// The web access seam (slices 4.6, 6.9, 10.1): fetch and search through one
// egress door so the URL-safety rules live in one place.
export type {
  WebAccessProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchRequest,
  WebSearchResult,
} from "./web-access.ts";

// The checked-in roadmap: every declared interface, the at-least-two
// implementations planned for it with the slice that lands each, and the
// data-shape interfaces that need none. provider-plan.test.ts fails when a
// declared interface is missing from either register.
export { PROVIDER_INTERFACES, PROVIDER_SHAPES } from "./provider-plan.ts";
