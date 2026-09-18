export const moduleInfo = {
  name: "@porkbot/core",
  summary:
    "Pure domain rules: run state machine, event reducer, policies. No I/O, no frameworks, no database drivers.",
} as const;

export {
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
  CompactionRuleError,
  CONVERSATION_ROLES,
  DuplicateConversationMessage,
  isConversationRole,
  MemoryCreatedByCompaction,
  MemoryDeletionByCompaction,
  MemoryRewriteByCompaction,
  MissingConversationMessageId,
  planCompaction,
  UnknownConversationRole,
} from "./compaction-policy.ts";
export type {
  CompactionPlan,
  CompactionRequest,
  ConversationMessage,
  ConversationRole,
} from "./compaction-policy.ts";

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
