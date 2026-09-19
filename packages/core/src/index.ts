export const moduleInfo = {
  name: "@porkbot/core",
  summary:
    "Pure domain rules: run state machine, event reducer, policies. No I/O, no frameworks, no database drivers.",
} as const;

export {
  ACTIVE_RUN_STATUSES,
  assertTransition,
  canTransition,
  IllegalTransition,
  INITIAL_RUN_STATUS,
  isActiveStatus,
  isRunStatus,
  isTerminalStatus,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  transition,
} from "./run-state.ts";
export type { RunStatus, TransitionResult } from "./run-state.ts";

export {
  ApprovalConflict,
  createThreadSnapshot,
  IllegalEventTransition,
  MessageConflict,
  reduceRunEvent,
  reduceRunEvents,
  ThreadMismatch,
  ToolCallConflict,
  UnknownToolCall,
} from "./event-reducer.ts";
export type {
  ApprovalSnapshot,
  CreateThreadSnapshotOptions,
  MessageSnapshot,
  ReduceRunEventResult,
  RunFailureSnapshot,
  RunSnapshot,
  ThreadSnapshot,
  ToolCallSnapshot,
} from "./event-reducer.ts";

export {
  isRunEventType,
  MalformedRunEvent,
  parseRunEvent,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_TYPES,
  RunEventError,
  UnknownEventType,
  UnknownSchemaVersion,
} from "./run-events.ts";
export type {
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunEvent,
  RunEventParseResult,
  RunEventType,
  RunFailedEvent,
  RunStartedEvent,
  RunSteeredEvent,
  TokenDeltaEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolRequestedEvent,
  ToolResultArtifact,
} from "./run-events.ts";

export {
  APPROVAL_DECISIONS,
  APPROVAL_POLL_INTERVAL_MS,
  APPROVAL_STATUSES,
  APPROVAL_VOTES,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  isApprovalDecision,
  isApprovalStatus,
  isPendingApproval,
} from "./approvals.ts";
export type { ApprovalDecision, ApprovalStatus, ApprovalVote } from "./approvals.ts";

export {
  DEFAULT_TOOL_RESULT_LIMITS,
  summarizeToolResult,
  toolResultTruncationMarker,
  unserializableToolResultPreview,
} from "./tool-results.ts";
export type { ToolResultLimits, ToolResultSummary } from "./tool-results.ts";

export { backoffDelayMs, DEFAULT_BACKOFF } from "./backoff.ts";
export type { BackoffOptions, BackoffPolicy } from "./backoff.ts";

export {
  decideSignup,
  isOwnerEmail,
  normalizeEmail,
  resolveDeploymentSettings,
} from "./signup-policy.ts";
export type {
  DeploymentSettings,
  DeploymentSettingsResolution,
  SignupDecision,
  SignupRole,
} from "./signup-policy.ts";

export {
  ClientNonceReused,
  ClientNonceTooLong,
  decideMessageSend,
  EmptyMessage,
  MAX_CLIENT_NONCE_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  MessageRuleError,
  MessageTooLong,
  MissingClientNonce,
} from "./messaging-policy.ts";
export type {
  ActiveRun,
  ExistingSend,
  MessageAction,
  MessageContext,
  MessageDecision,
  SendMessageRequest,
} from "./messaging-policy.ts";

export { isMessageBlock, messageText, textMessageBlocks } from "./message-blocks.ts";
export type { MessageBlock, TextMessageBlock } from "./message-blocks.ts";

export {
  decideRoutineDue,
  InvalidRoutineCron,
  InvalidRoutineTimezone,
  isRoutineTimezone,
  nextRoutineFire,
  parseRoutineCron,
  ROUTINE_CRON_FIELDS,
  ROUTINE_MISS_GRACE_MS,
  RoutineScheduleError,
  UnreachableRoutineSchedule,
} from "./routine-schedule.ts";
export type { RoutineCron, RoutineDueDecision, RoutineDueInput } from "./routine-schedule.ts";

export {
  AgentCannotDeleteMemory,
  decideMemoryWrite,
  EmptyMemoryContent,
  EmptyMemoryTitle,
  isMemoryKind,
  isMemoryWriteOrigin,
  MAX_MEMORY_CONTENT_LENGTH,
  MAX_MEMORY_DOCUMENT_ID_LENGTH,
  MAX_MEMORY_DOCUMENTS_PER_BOT,
  MAX_MEMORY_REASON_LENGTH,
  MAX_MEMORY_TITLE_LENGTH,
  MEMORY_KINDS,
  MEMORY_WRITE_ORIGINS,
  MemoryContentTooLong,
  MemoryDocumentExists,
  MemoryDocumentIdTooLong,
  MemoryDocumentLimitReached,
  MemoryReasonTooLong,
  MemoryRuleError,
  MemoryTitleTooLong,
  MissingMemoryAuthor,
  MissingMemoryDocumentId,
  MissingMemoryReason,
  UnknownMemoryAction,
  UnknownMemoryDocument,
  UnknownMemoryKind,
  UnknownMemoryOrigin,
} from "./memory-rules.ts";
export type {
  MemoryDocument,
  MemoryKind,
  MemoryRevision,
  MemoryWrite,
  MemoryWriteContext,
  MemoryWriteDecision,
  MemoryWriteOrigin,
  MemoryWriteRequest,
} from "./memory-rules.ts";

export {
  assertMemoryPreserved,
  COMPACTION_SUMMARY_INSTRUCTIONS,
  compactionSummaryRequest,
  CompactionRuleError,
  CONVERSATION_ROLES,
  DuplicateConversationMessage,
  EmptyCompactionPlan,
  isConversationRole,
  MemoryCreatedByCompaction,
  MemoryDeletionByCompaction,
  MemoryRewriteByCompaction,
  MissingConversationMessageId,
  planCompaction,
  UnknownCompactionMessage,
  UnknownConversationRole,
} from "./compaction-policy.ts";
export type {
  CompactionPlan,
  CompactionRequest,
  CompactionSummaryMessage,
  ConversationMessage,
  ConversationRole,
} from "./compaction-policy.ts";

export {
  assertRecallLimits,
  boundRecallMatches,
  DEFAULT_RECALL_LIMITS,
  RecallLimitError,
  selectPromptMemory,
} from "./recall-policy.ts";
export type {
  BoundedRecall,
  PromptMemorySelection,
  RecallLimits,
  RecallMatch,
} from "./recall-policy.ts";

export { composeRunPrompt } from "./run-context.ts";
export type { RunPrompt, RunPromptInput } from "./run-context.ts";

export {
  decideReclaim,
  isResumableCheckpoint,
  reclaimFailureMessage,
  RUN_RECLAIM_FAILURES,
} from "./run-recovery.ts";
export type { ReclaimDecision, RunReclaimFailure } from "./run-recovery.ts";

export {
  AmbiguousSectionPrecedence,
  BlankMemoryRecord,
  composeSystemPrompt,
  DATA_CHANNEL_NOTICE,
  EmptyBotName,
  EmptySectionContent,
  EmptySectionHeading,
  EmptySectionId,
  PROMPT_SECTION_CHANNELS,
  PromptCompositionError,
  ReservedSectionId,
  SectionOrderOutOfRange,
  SYSTEM_SECTION_IDS,
  SYSTEM_SECTION_ORDERS,
  UnknownSectionChannel,
} from "./prompt-composition.ts";
export type {
  ComposePromptInput,
  ComposedPrompt,
  ComposedPromptSection,
  PromptBotIdentity,
  PromptMemoryDocument,
  PromptSection,
  PromptSectionChannel,
  SystemSectionId,
} from "./prompt-composition.ts";

export {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isNotificationKind,
  NOTIFICATION_KINDS,
  resolveNotificationPreferences,
  shouldNotify,
} from "./notification-policy.ts";
export type {
  NotificationKind,
  NotificationPreferenceSet,
  StoredNotificationPreference,
} from "./notification-policy.ts";

// The MCP server registry's closed vocabularies (slice 9.5, PRD story 38):
// auth mode and lifecycle status. The database enum, the durable store and the
// transport schema build from these constants so none of them can disagree.
export {
  isMcpServerStatus,
  MCP_AUTH_MODES,
  MCP_SERVER_INITIAL_STATUS,
  MCP_SERVER_STATUSES,
} from "./mcp-registry.ts";
export type { McpAuthMode, McpServerStatus } from "./mcp-registry.ts";

export {
  INGESTION_PATH_DEFINITIONS,
  INGESTION_PATHS,
  IngestionError,
  InvalidIngestedContent,
  isIngestionPath,
  isUntrustedContent,
  labelUntrustedContent,
  MissingContentOrigin,
  stripOriginCredentials,
  UNTRUSTED_LABEL,
  UnlabelledContent,
  UnknownIngestionPath,
  untrustedPromptSection,
} from "./ingestion.ts";
export type {
  IngestionPath,
  IngestionPathDefinition,
  UntrustedContent,
  UntrustedContentInput,
  UntrustedLabel,
  UntrustedSectionOptions,
} from "./ingestion.ts";

export {
  decideEgress,
  EgressAllowlistError,
  EMPTY_EGRESS_ALLOWLIST,
  InvalidEgressHost,
  isHostAllowed,
  parseEgressAllowlist,
} from "./egress-policy.ts";
export type {
  EgressAllowlist,
  EgressDecision,
  EgressHostRejection,
  EgressHostRule,
} from "./egress-policy.ts";
