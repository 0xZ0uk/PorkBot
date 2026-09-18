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
} from "./run-events.ts";

export { backoffDelayMs, DEFAULT_BACKOFF } from "./backoff.ts";
export type { BackoffOptions, BackoffPolicy } from "./backoff.ts";

export { decideSignup, isOwnerEmail, normalizeEmail } from "./signup-policy.ts";
export type { DeploymentSettings, SignupDecision, SignupRole } from "./signup-policy.ts";

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
