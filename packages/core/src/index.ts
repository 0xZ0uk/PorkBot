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
