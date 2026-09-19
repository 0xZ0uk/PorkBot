import type { RunStatus } from "@porkbot/core";
import type { attemptStatus, messageRole, taskStatus } from "./schema/enums.ts";

/**
 * The row shapes and column projections every query in this package shares.
 *
 * They live in one module so a projection cannot drift between the repository
 * reads, the run-creation command and the duplicate-submission replay: all
 * three select the same columns under the same aliases, and the aliases are the
 * camelCase fields the records declare. Adding a column is one edit here.
 */

/** A bot row as the schema stores it; timestamps are the server's, never the host's. */
export interface BotRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly userId: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly color: string;
  readonly pinned: boolean;
  readonly position: number;
  readonly sectionId: string | null;
  readonly archivedAt: Date | null;
  readonly spawnKey: string;
  readonly avatarKey: string | null;
  readonly computerId: string | null;
  /** The connection this bot selected, or null to use the space default (slice 9.2). */
  readonly modelConnectionId: string | null;
  /** The model this bot selected, or null to use its connection's default (slice 9.2). */
  readonly model: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A model connection row (slice 9.2): where an OpenAI-compatible endpoint
 * lives and which stored credential name opens it. The value of that
 * credential is never a field; the name is what a provider resolves.
 */
export interface ModelConnectionRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly credentialName: string;
  readonly defaultModel: string | null;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A bot section row: the named group a bot may be filed under. */
export interface BotSectionRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly userId: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ThreadRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly botId: string;
  readonly userId: string;
  readonly nextEventSeq: number;
  readonly nextMessageSeq: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The task statuses the schema's enum allows, derived from it. */
export type TaskStatus = (typeof taskStatus.enumValues)[number];

/** The message roles the schema's enum allows, derived from it. */
export type MessageRole = (typeof messageRole.enumValues)[number];

/** The attempt statuses the schema's enum allows, derived from it. */
export type AttemptStatus = (typeof attemptStatus.enumValues)[number];

/** A task row: the durable unit of requested work a run executes. */
export interface TaskRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A message row: one entry in a thread's transcript. */
export interface MessageRecord {
  readonly id: string;
  readonly threadId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly blocks: unknown;
  readonly runId: string | null;
  readonly clientNonce: string;
  readonly createdAt: Date;
}

/**
 * One persisted thread event: the durable row an SSE subscription replays from.
 * `seq` is the cursor position — contiguous and per-thread, with
 * `(thread_id, seq)` unique — and `type` plus `payload` are the wire event the
 * reducer in `@porkbot/core` interprets. `runId` is nullable because the table
 * is thread-scoped and a future thread event need not belong to a run.
 */
export interface EventRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly threadId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly runId: string | null;
  readonly createdAt: Date;
}

export interface RunRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly taskId: string;
  readonly userId: string;
  readonly status: RunStatus;
  readonly trigger: string;
  readonly error: string | null;
  readonly errorCode: string | null;
  readonly leaseOwner: string | null;
  readonly leaseFence: number;
  readonly leaseExpiresAt: Date | null;
  /** When the operator asked this run to stop, if they did (slice 6.7). */
  readonly stopRequestedAt: Date | null;
  readonly checkpoint: Record<string, unknown>;
  readonly clientNonce: string;
  readonly sourceMessageId: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A routine row: the schedule and the instruction the scheduler fires. */
export interface RoutineRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly botId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly instruction: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly nextRunAt: Date;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One settled schedule slot: a fire linked to its run, or a missed schedule. */
export interface RoutineOccurrenceRecord {
  readonly id: string;
  readonly routineId: string;
  readonly scheduledFor: Date;
  readonly runId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * How a fire ended, read from the run's own status rather than copied into a
 * second column. `running` covers every non-terminal run status, including the
 * queued moment before a worker claims it and the approval wait.
 */
export type RoutineOutcomeStatus = "success" | "failure" | "cancelled" | "missed" | "running";

/** One row of a routine's outcome history: the slot and what became of it. */
export interface RoutineOutcomeRecord {
  readonly occurrenceId: string;
  readonly scheduledFor: Date;
  readonly runId: string | null;
  readonly status: RoutineOutcomeStatus;
}

export const botColumns =
  'id, space_id as "spaceId", user_id as "userId", name, title, description, instructions, ' +
  'color, pinned, position, section_id as "sectionId", archived_at as "archivedAt", ' +
  'spawn_key as "spawnKey", avatar_key as "avatarKey", computer_id as "computerId", ' +
  'model_connection_id as "modelConnectionId", model, ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

export const modelConnectionColumns =
  'id, space_id as "spaceId", label, base_url as "baseUrl", ' +
  'credential_name as "credentialName", default_model as "defaultModel", ' +
  'is_default as "isDefault", created_at as "createdAt", updated_at as "updatedAt"';

export const botSectionColumns =
  'id, space_id as "spaceId", user_id as "userId", name, position, ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

export const threadColumns =
  'id, space_id as "spaceId", bot_id as "botId", user_id as "userId", ' +
  'next_event_seq as "nextEventSeq", next_message_seq as "nextMessageSeq", ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

export const taskColumns =
  'id, space_id as "spaceId", bot_id as "botId", thread_id as "threadId", ' +
  'user_id as "userId", prompt, status::text as "status", ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

export const messageColumns =
  'id, thread_id as "threadId", seq, role::text as "role", blocks, ' +
  'run_id as "runId", client_nonce as "clientNonce", created_at as "createdAt"';

export const eventColumns =
  'id, space_id as "spaceId", thread_id as "threadId", seq, type, payload, ' +
  'run_id as "runId", created_at as "createdAt"';

export const routineColumns =
  'id, space_id as "spaceId", bot_id as "botId", user_id as "userId", thread_id as "threadId", ' +
  'instruction, cron, timezone, enabled, next_run_at as "nextRunAt", deleted_at as "deletedAt", ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

export const routineOccurrenceColumns =
  'id, routine_id as "routineId", scheduled_for as "scheduledFor", run_id as "runId", ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

export const runColumns =
  'id, space_id as "spaceId", bot_id as "botId", thread_id as "threadId", ' +
  'task_id as "taskId", user_id as "userId", status::text as "status", "trigger", error, ' +
  'error_code as "errorCode", lease_owner as "leaseOwner", lease_fence as "leaseFence", ' +
  'lease_expires_at as "leaseExpiresAt", stop_requested_at as "stopRequestedAt", ' +
  'checkpoint, client_nonce as "clientNonce", ' +
  'source_message_id as "sourceMessageId", started_at as "startedAt", ' +
  'completed_at as "completedAt", created_at as "createdAt", updated_at as "updatedAt"';
