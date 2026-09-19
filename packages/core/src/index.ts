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
  TooManyAttachments,
} from "./messaging-policy.ts";
export type {
  ActiveRun,
  ExistingSend,
  MessageAction,
  MessageContext,
  MessageDecision,
  SendMessageRequest,
} from "./messaging-policy.ts";

export {
  isFileMessageBlock,
  isMessageBlock,
  isTextMessageBlock,
  messageBlocksForSend,
  messageFiles,
  messagePromptWithAttachments,
  messageText,
  textMessageBlocks,
} from "./message-blocks.ts";
export type { FileMessageBlock, MessageBlock, TextMessageBlock } from "./message-blocks.ts";

export {
  attachmentFileName,
  attachmentWorkspacePath,
  COMPUTER_HOME_DIRECTORY,
  confineToHome,
  contentTypeForFileName,
  homePathRefusalMessage,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILE_NAME_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MESSAGE_ATTACHMENTS_DIRECTORY,
  resolveComputerPath,
} from "./files.ts";
export type {
  ComputerPathResolution,
  HomePath,
  HomePathRefusal,
  HomePathResolution,
  ResolvedComputerPath,
} from "./files.ts";

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
  AgentCannotRestoreMemory,
  decideMemoryRestore,
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
  UnknownMemoryRevision,
} from "./memory-rules.ts";
export type {
  MemoryDocument,
  MemoryKind,
  MemoryRestoreContext,
  MemoryRestoreDecision,
  MemoryRestoreRequest,
  MemoryRestoreTarget,
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
  assessRunLiveness,
  createRunProgress,
  isRunStepKind,
  RUN_LIVENESS_STATES,
  RUN_STALL_THRESHOLD_SECONDS,
  RUN_STEP_KINDS,
} from "./run-liveness.ts";
export type {
  RunLiveness,
  RunLivenessSnapshot,
  RunLivenessState,
  RunProgress,
  RunProgressOptions,
  RunProgressSnapshot,
  RunStep,
  RunStepKind,
} from "./run-liveness.ts";

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

// Bot secrets (slice 9.6, E9 epic): the name, origin and authentication
// vocabulary a request, a durable row and a proxy grant are written from, and
// the one function that turns a destination plus a value into the request
// header the run's credential proxy injects. The value is never a field of
// anything this module returns except that header.
export {
  botSecretCredentialHeader,
  BOT_SECRET_AUTH_TYPES,
  BOT_SECRET_NAME_PATTERN,
  BOT_SECRET_STATUSES,
  isBotSecretName,
  isBotSecretOrigin,
  isBotSecretStatus,
  MAX_BOT_SECRET_NAME_LENGTH,
  MAX_BOT_SECRET_USERNAME_LENGTH,
  MAX_BOT_SECRET_VALUE_LENGTH,
  parseBotSecretAuth,
  parseBotSecretDestination,
  sameBotSecretDestination,
} from "./bot-secrets.ts";
export type {
  BotSecretAuth,
  BotSecretDestination,
  BotSecretDestinationParse,
  BotSecretDestinationRejection,
  BotSecretStatus,
} from "./bot-secrets.ts";

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

export {
  classifyDangerousAction,
  connectorDangerousActions,
  CONNECTOR_DELETE_VERBS,
  CONNECTOR_SEND_VERBS,
  CREDENTIAL_STORE_DIRECTORIES,
  CREDENTIAL_STORE_FILES,
  DANGEROUS_ACTION_CLASSES,
  isCredentialStorePath,
  isDangerousActionClass,
} from "./dangerous-actions.ts";
export type {
  DangerousAction,
  DangerousActionClass,
  DangerousActionClassification,
  DangerousActionRequest,
} from "./dangerous-actions.ts";

export {
  assertComputerNetworkPlan,
  COMPUTER_NETWORK_PREFIX,
  computerNetworkPlanProblems,
  MAX_COMPUTER_NETWORK_NAME_LENGTH,
  planComputerNetwork,
  RESERVED_NETWORK_NAMES,
} from "./computer-network.ts";
export type {
  ComputerIdentity,
  ComputerNetworkPlan,
  ComputerNetworkPlanProblem,
} from "./computer-network.ts";
