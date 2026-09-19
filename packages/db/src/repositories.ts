import type { CredentialStore } from "@porkbot/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@porkbot/core";
import { NameConflictError, NotFoundError } from "@porkbot/effect";
import type {
  Credentials,
  McpRunServers,
  McpServers,
  MemoryDocuments,
  NotificationPreferences,
  NotificationRecipients,
  RunCommandSource,
} from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import {
  claimSteeringMessages,
  clearThread,
  createAssistantMessageStore,
  createSteeringMessageStore,
  readMessages,
} from "./messages.ts";
import type { AssistantMessageWriter, MessageReader, SteeringMessageWriter } from "./messages.ts";
import type { Queryable } from "./queryable.ts";
import type { CredentialKeyring } from "./credential-cipher.ts";
import { createEncryptedCredentialStore } from "./encrypted-credential-store.ts";
import { createMcpStore } from "./mcp-store.ts";
import { createMemoryStore } from "./memory-store.ts";
import { createNotificationStore } from "./notification-store.ts";
import {
  botColumns,
  botSectionColumns,
  eventColumns,
  modelConnectionColumns,
  runColumns,
  threadColumns,
} from "./records.ts";
import type {
  BotRecord,
  BotSectionRecord,
  EventRecord,
  ModelConnectionRecord,
  RunRecord,
  ThreadRecord,
} from "./records.ts";
import { createRunAndTask } from "./run-creation.ts";
import type { CreatedRunAndTask, NewRunAndTask } from "./run-creation.ts";
import { createRoutineStore } from "./routines.ts";
import type { RoutineReader, RoutineScheduler, RoutineWriter } from "./routines.ts";
import {
  abandonAttempt,
  adoptRun,
  claimRun,
  heartbeatRun,
  reclaimRun,
  updateClaimedRun,
} from "./run-leases.ts";
import type { FencedRunPatch, ReclaimOptions, RunLease, RunProgressStamp } from "./run-leases.ts";
import { markRunStalled } from "./run-liveness.ts";
import { insertedRow, isUniqueViolation, requiredRow } from "./rows.ts";
import { createToolResultReader } from "./tool-call-ledger.ts";
import type { ToolResultReader } from "./tool-call-ledger.ts";

export type {
  BotRecord,
  BotSectionRecord,
  EventRecord,
  MessageRecord,
  MessageRole,
  ModelConnectionRecord,
  RunRecord,
  TaskRecord,
  TaskStatus,
  ThreadRecord,
} from "./records.ts";

/**
 * The actor-scoped repository layer: the only way `packages/db` touches domain
 * rows. Two pre-actor paths are deliberate exceptions, both taking no tenant id
 * and neither reaching a `bot`, `thread` or `run`:
 *
 *   - `readDeploymentSettings` reads the deployment-global configuration before
 *     an actor can exist, and returns no tenant data;
 *   - `bootstrapSignup` writes the tenancy rows a registration needs (the
 *     space and the membership) and returns the actor those rows resolve to.
 *     It is where the actor comes from in the first place, not a second way to
 *     scope one.
 *
 * Every repository is built by `createRepositories(actor, database)` and every
 * statement binds the actor's `spaceId`. There is no factory that takes a space
 * or a user id, no repository method that accepts one, and no query that omits
 * the space predicate — a tenant id is never an argument, it is the scope the
 * repository was constructed with (PRD decision 7, and the criterion that
 * nothing in this package takes a space or user id as a plain argument).
 *
 * Reads are uniform: `findById` filters `id = $1 and space_id = $2`, so a row
 * in another space and a row that does not exist produce the same
 * `NotFoundError`. Writes are scoped the same way — `update` carries the space
 * predicate, and a write whose parent belongs to another space is expressed as
 * `insert ... select` over that parent's row, so a cross-space insert matches
 * no row instead of relying on a check-then-insert race.
 *
 * The factory hands a `UserActor` writes that carry a user of record, while a
 * `SystemActor` receives only the fenced run writes that carry no user (claim,
 * reclaim, heartbeat, execution updates) and the routine scheduler's half
 * (settle one slot). A job still cannot create a bot, thread or routine by
 * borrowing a user identity it does not have.
 *
 * Runs are the exception to the one-method-per-write shape: the commands in
 * `run-creation.ts` — message-triggered, routine-triggered and the operator's
 * test run — are the only code paths in the package that insert a task or a
 * run. Each builds its rows in one transaction, so no caller has to remember
 * the order or the links, and the routine command settles the occurrence
 * ledger in the same transaction as the run it creates.
 */

/**
 * What a caller must supply to create a bot. There is deliberately no `spaceId`
 * and no `userId`: both come from the actor, and accepting either here would be
 * the tenant-id argument this slice exists to remove.
 */
export interface NewBot {
  readonly name: string;
  readonly color: string;
  readonly spawnKey: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly instructions?: string | undefined;
  readonly pinned?: boolean | undefined;
  readonly position?: number | undefined;
  /** A section in the actor's space; one outside it is a `NotFoundError`. */
  readonly sectionId?: string | null | undefined;
  /**
   * The computer assigned to the bot. It is opaque until the `computer` table
   * lands with epic E7; nothing validates it against a row yet, and that is
   * documented rather than implied.
   */
  readonly computerId?: string | null | undefined;
  /** A connection in the actor's space; one outside it is a `NotFoundError`. */
  readonly modelConnectionId?: string | null | undefined;
  /** The model this bot selects, overriding its connection's default. */
  readonly model?: string | null | undefined;
}

/** The mutable bot fields; an absent key is left untouched. */
export interface BotPatch {
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly instructions?: string | undefined;
  readonly color?: string | undefined;
  readonly pinned?: boolean | undefined;
  readonly position?: number | undefined;
  /** `null` unfiles the bot; a section outside the actor's space is not found. */
  readonly sectionId?: string | null | undefined;
  /** `null` clears the assignment; E7 adds the reference that validates it. */
  readonly computerId?: string | null | undefined;
  /** `null` falls back to the space's default connection. */
  readonly modelConnectionId?: string | null | undefined;
  /** `null` falls back to the selected connection's default model. */
  readonly model?: string | null | undefined;
}

/**
 * Which archived state a list includes. `active` is the default because an
 * archived bot is out of the way until it is explicitly asked for; `all` exists
 * for an operator view that shows both, and `archived` for the restore screen.
 */
export type BotListScope = "active" | "archived" | "all";

export interface BotReader {
  /** Throws `NotFoundError` for a missing id and for one in another space alike. */
  findById(id: string): Promise<BotRecord>;
  list(scope?: BotListScope): Promise<readonly BotRecord[]>;
}

export interface BotWriter {
  /**
   * Creates the bot, or replays the one already holding the spawn key. The
   * insert is the duplicate decision — a resubmitted key returns the first
   * row, never a second bot — and a section outside the actor's space is a
   * `NotFoundError` with nothing inserted.
   */
  create(input: NewBot): Promise<BotRecord>;
  update(id: string, patch: BotPatch): Promise<BotRecord>;
  /** Idempotent: archiving an archived bot keeps the original instant. */
  archive(id: string): Promise<BotRecord>;
  /** Idempotent: restoring an active bot is a no-op that returns the row. */
  restore(id: string): Promise<BotRecord>;
  /**
   * Hard-deletes the bot row and everything that dangles from it — its threads,
   * tasks, runs and steering messages cascade. The caller owns what the
   * database cannot reach: the avatar object in the storage seam. The deleted
   * row is returned so that cleanup can name the bot it belongs to.
   */
  delete(id: string): Promise<BotRecord>;
  /** Points the bot at a storage key; `null` clears it. */
  setAvatar(id: string, avatarKey: string | null): Promise<BotRecord>;
}

/** What a caller must supply to create a model connection (slice 9.2). */
export interface NewModelConnection {
  readonly label: string;
  readonly baseUrl: string;
  /** The name a provider resolves; the value stays in the credential store. */
  readonly credentialName: string;
  /** The model this connection uses unless a bot overrides it. */
  readonly defaultModel?: string | null | undefined;
}

/** The mutable connection fields; an absent key is left untouched. */
export interface ModelConnectionPatch {
  readonly label?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly credentialName?: string | undefined;
  /** `null` clears the connection's default model. */
  readonly defaultModel?: string | null | undefined;
}

export interface ModelConnectionReader {
  /** Throws `NotFoundError` for a missing id and for one in another space alike. */
  findById(id: string): Promise<ModelConnectionRecord>;
  list(): Promise<readonly ModelConnectionRecord[]>;
}

export interface ModelConnectionWriter {
  /**
   * Creates the connection. A label already used in the actor's space is a
   * `NameConflictError`; the first connection is not implicitly the space
   * default, because "which one is the default" is an explicit operator
   * decision the settings surface records with `setDefault`.
   */
  create(input: NewModelConnection): Promise<ModelConnectionRecord>;
  update(id: string, patch: ModelConnectionPatch): Promise<ModelConnectionRecord>;
  /** Makes exactly this connection the space's default; idempotent. */
  setDefault(id: string): Promise<ModelConnectionRecord>;
  /** Removes the connection; bots that selected it fall back to the space default. */
  delete(id: string): Promise<ModelConnectionRecord>;
}

/**
 * The model a bot actually runs: the connection (URL and credential name) and
 * the model id, after the per-bot override and the space default are applied.
 * Nothing here is a secret: the credential is still only a name.
 */
export interface ModelSelection {
  readonly connectionId: string;
  readonly baseUrl: string;
  readonly credentialName: string;
  readonly model: string;
}

export interface ModelSelectionReader {
  /**
   * The effective selection for one bot: its own connection and model, or the
   * space's default connection and that connection's default model. Answers
   * `undefined` when no connection resolves or no model is selected, so the
   * run executor reports "no model selected" rather than guessing.
   */
  resolveForBot(botId: string): Promise<ModelSelection | undefined>;
}

/** What a caller must supply to create a bot section. */
export interface NewBotSection {
  readonly name: string;
  readonly position?: number | undefined;
}

/** The mutable section fields; an absent key is left untouched. */
export interface BotSectionPatch {
  readonly name?: string | undefined;
  readonly position?: number | undefined;
}

export interface SectionReader {
  list(): Promise<readonly BotSectionRecord[]>;
}

export interface SectionWriter {
  /** A name already in use by the actor's user is a `NameConflictError`. */
  create(input: NewBotSection): Promise<BotSectionRecord>;
  /** Renaming onto a name in use is a `NameConflictError`. */
  update(id: string, patch: BotSectionPatch): Promise<BotSectionRecord>;
  /** Deletes the section; its bots stay and become unfiled. */
  delete(id: string): Promise<BotSectionRecord>;
}

/**
 * One page of a bot's threads. The keyset cursor is the ordering key itself —
 * `(updated_at desc, id desc)` — so a page boundary is a position rather than
 * an offset that shifts when a thread is touched, and a thread updated between
 * pages cannot make the walk skip a row or repeat one silently.
 */
export interface ThreadPage {
  readonly limit: number;
  readonly before?: { readonly updatedAt: Date; readonly id: string } | undefined;
}

export interface ThreadReader {
  findById(id: string): Promise<ThreadRecord>;
  /** Most recently active first, scoped to the actor's space. */
  listForBot(botId: string, page: ThreadPage): Promise<readonly ThreadRecord[]>;
}

export interface ThreadWriter {
  /** Fails closed when the bot is outside the actor's space; nothing is inserted. */
  createForBot(botId: string): Promise<ThreadRecord>;
  /**
   * Empties the thread's transcript and its event stream and resets both
   * counters, in one transaction. The thread row survives, its runs survive,
   * and the bot's memory documents are not touched: clearing is a reset of the
   * conversation, never a deletion of what the bot knows.
   */
  clear(threadId: string): Promise<ThreadRecord>;
}

export interface RunReader {
  findById(id: string): Promise<RunRecord>;
  listForThread(threadId: string): Promise<readonly RunRecord[]>;
  /**
   * The thread's newest non-terminal run, when one exists. The send path asks
   * before it creates anything, so a message that reaches a live run is a
   * steer rather than a second concurrent run (PRD story 20).
   */
  findActiveForThread(threadId: string): Promise<RunRecord | undefined>;
}

/**
 * The durable half of a thread subscription (slice 4.3): the events a client
 * replays from its cursor. The read is actor-scoped like every other one, so a
 * thread id from another space returns no rows — and the subscription validates
 * the thread itself first, so a cross-space id is a `NotFoundError` rather than
 * an idle stream. `afterSeq` is exclusive: a reconnect receives every event
 * with a position greater than its cursor and nothing it has already seen.
 */
export interface EventReader {
  listAfter(threadId: string, afterSeq: number, limit: number): Promise<readonly EventRecord[]>;
}

/** The single run-creation command; nothing else in the package inserts a run. */
export interface RunWriter {
  /**
   * Creates the user message, the task and the run in one transaction.
   *
   * Submitting the same `(space, clientNonce)` twice returns the first result;
   * the conflict is resolved by the run's unique index, so a resubmission is a
   * replay and never a second run, sequential or concurrent. The nonce is
   * scoped to the space, not the thread, so a replay can return a run created
   * for another thread. A thread outside the actor's space is a
   * `NotFoundError`, and nothing is written.
   *
   * `database` must be one connection for the duration of the call — a
   * `pg.Client`, or a client checked out of a pool and released afterwards —
   * because the command opens a transaction on it.
   */
  create(input: NewRunAndTask): Promise<CreatedRunAndTask>;
  /**
   * Marks a live run for its operator's stop (slice 6.7, story 21). The mark
   * is set once — a second request keeps the first instant — and the run's
   * executor observes it, cancels the session and settles the row, so this
   * command itself changes no status. A run outside the actor's space is the
   * shared `NotFoundError`; a run that already finished is returned as it is,
   * because asking again to stop something stopped is idempotent, not an
   * error.
   */
  requestStop(id: string): Promise<RunRecord>;
}

export interface SystemRunWriter {
  /** Returns undefined when this delivery lost the atomic claim race. */
  claim(id: string, expectedFence: number, owner: string): Promise<RunRecord | undefined>;
  /**
   * Returns undefined until the active owner's TTL has elapsed, or after a lost
   * race. A successful reclaim closes the previous attempt and settles the
   * previous owner's in-flight tool calls with the same reason.
   */
  reclaim(
    id: string,
    expectedFence: number,
    owner: string,
    options: ReclaimOptions,
  ): Promise<RunRecord | undefined>;
  /**
   * Takes over the live lease held by exactly `previousOwner` at
   * `expectedFence`; undefined when either guard no longer matches.
   */
  adopt(
    id: string,
    expectedFence: number,
    owner: string,
    previousOwner: string,
  ): Promise<RunRecord | undefined>;
  /** Renews the lease and stamps the caller's progress in the same statement. */
  heartbeat(id: string, lease: RunLease, progress: RunProgressStamp): Promise<RunRecord>;
  update(id: string, lease: RunLease, patch: FencedRunPatch): Promise<RunRecord>;
  /**
   * Records the start of one stall episode (slice 6.10). Undefined when the
   * run progressed, parked, stopped, lost its lease or was already marked
   * between the scan and this write, so only one detector notifies.
   */
  markStalled(id: string, thresholdSeconds: number): Promise<RunRecord | undefined>;
  /** Closes this fence's own attempt after ownership moved on; true when it did. */
  abandonAttempt(id: string, fence: number, reason: string): Promise<boolean>;
}

/** A job's scope: it may read the space its payload names and nothing else. */
export interface SystemRepositories {
  readonly actor: SystemActor;
  readonly bots: BotReader;
  readonly threads: ThreadReader;
  readonly runs: RunReader & SystemRunWriter;
  /** The run's own output: the assistant messages it produced. */
  readonly messages: AssistantMessageWriter;
  /**
   * The live run's command source (slice 6.7): the steering rows it claims
   * and the stop mark it observes. The pump beside the session reads it; the
   * statements stay scoped to the job's space.
   */
  readonly commands: RunCommandSource;
  /** The scheduler's half: settle one routine slot through the job's space. */
  readonly routines: RoutineScheduler;
  /**
   * The delivery path's half (slice 8.6): whether one member of the job's
   * space has enabled one notification kind. The membership check is inside
   * the read, so a user outside the space is `not_a_recipient`.
   */
  readonly notifications: NotificationRecipients;
  /**
   * The provider half (slice 9.1): resolve one named credential through the
   * job's space. A system actor cannot enumerate or write credentials.
   */
  readonly credentials: CredentialStore;
  /**
   * The run half of MCP servers (slice 9.5): the servers and tools a bot was
   * granted, and the live grant re-check the tool layer asks before a call. A
   * job can never install, rewrite or grant a server.
   */
  readonly mcp: McpRunServers;
  /**
   * The model selection read (slice 9.2): the connection and model a bot
   * resolves to, after the per-bot override and the space default. A job
   * resolves a selection; it cannot edit connections or set defaults.
   */
  readonly modelConnections: ModelSelectionReader;
}

/**
 * How the actor-scoped repositories reach the credential keyring. It is
 * configuration rather than data, so it is passed beside the connection the
 * repositories are built over and not read from the environment here: the
 * composition root parses `PORKBOT_CREDENTIAL_KEYS` once. Omitted, the
 * credential store is locked and every credential call raises the typed
 * `CredentialStoreError` rather than reading a row it cannot authenticate.
 */
export interface RepositoryOptions {
  readonly credentialKeys?: CredentialKeyring | undefined;
}

/**
 * The authorization root re-read (slice 3.3): the one fact a long-lived path
 * re-checks for itself. The gate resolves an actor once per request, and a
 * request-scoped handler cannot outlive its own resolution; a subscription can,
 * so its replay loop asks this before each step and ends the stream when the
 * membership row is gone. No space or user id is an argument — the scope is the
 * actor the reader was built from, exactly like every other repository read.
 */
export interface MembershipReader {
  /**
   * Resolves while the actor's `space_member` row still exists and throws the
   * shared `NotFoundError` once it was revoked. A revoked membership and a
   * missing one are the same answer, as every scoped read reports them.
   */
  requireActive(): Promise<void>;
}

/** An operator's scope: reads plus the writes that carry a user of record. */
export interface UserRepositories {
  readonly actor: UserActor;
  readonly membership: MembershipReader;
  readonly bots: BotReader & BotWriter;
  readonly sections: SectionReader & SectionWriter;
  readonly threads: ThreadReader & ThreadWriter;
  readonly runs: RunReader & RunWriter;
  readonly events: EventReader;
  /** The transcript: page reads, the nonce lookup, and sending a steer. */
  readonly messages: MessageReader & SteeringMessageWriter;
  /**
   * The full value behind a tool call whose event carried only a preview
   * (slice 6.8). Keyed by the artifact pointer's `(threadId, runId, callId)`,
   * so the console follows the link the event gave it without naming a row.
   */
  readonly toolResults: ToolResultReader;
  readonly routines: RoutineReader & RoutineWriter;
  /** The operator's own notification switches (slice 8.6). */
  readonly notifications: NotificationPreferences;
  /** The operator's stored credentials (slice 9.1), masked on list. */
  readonly credentials: Credentials;
  /**
   * The operator's MCP servers (slice 9.5): install, inspect, refresh, remove
   * and the per-bot grants. The credential value itself stays behind
   * `credentials`; every shape here carries only the name it resolves under.
   */
  readonly mcp: McpServers;
  /** The operator's model connections (slice 9.2): endpoints by URL and credential name. */
  readonly modelConnections: ModelConnectionReader & ModelConnectionWriter;
  /**
   * The operator's durable memory (slices 8.1-8.3, PRD decision 21; stories 23
   * and 24): live and deleted documents, revision history, deliberate writes
   * and restoring a recorded revision. The run's half stays the separate
   * `MemoryProposals` created for the worker, so the UI cannot propose and the
   * agent cannot delete or restore.
   */
  readonly memory: MemoryDocuments;
}

export type Repositories = UserRepositories | SystemRepositories;

export function createRepositories(
  actor: UserActor,
  database: Queryable,
  options?: RepositoryOptions,
): UserRepositories;
export function createRepositories(
  actor: SystemActor,
  database: Queryable,
  options?: RepositoryOptions,
): SystemRepositories;
export function createRepositories(
  actor: Actor,
  database: Queryable,
  options?: RepositoryOptions,
): Repositories;
export function createRepositories(
  actor: Actor,
  database: Queryable,
  options?: RepositoryOptions,
): Repositories {
  const bots = readBots(actor, database);
  const threads = readThreads(actor, database);
  const runs = readRuns(actor, database);
  const events = readEvents(actor, database);
  const messages = readMessages(actor, database);

  if (actor.kind === "system") {
    return {
      actor,
      bots,
      threads,
      runs: {
        ...runs,
        claim: (id, expectedFence, owner) => claimRun(actor, database, id, expectedFence, owner),
        reclaim: (id, expectedFence, owner, options) =>
          reclaimRun(actor, database, id, expectedFence, owner, options),
        adopt: (id, expectedFence, owner, previousOwner) =>
          adoptRun(actor, database, id, expectedFence, owner, previousOwner),
        heartbeat: (id, lease, progress) => heartbeatRun(actor, database, id, lease, progress),
        update: (id, lease, patch) => updateClaimedRun(actor, database, id, lease, patch),
        markStalled: (id, thresholdSeconds) =>
          markRunStalled(actor, database, id, thresholdSeconds),
        abandonAttempt: (id, fence, reason) => abandonAttempt(actor, database, id, fence, reason),
      },
      messages: createAssistantMessageStore(actor, database),
      commands: createRunCommandSource(actor, database),
      routines: createRoutineStore(actor, database),
      notifications: createNotificationStore(actor, database),
      credentials: createEncryptedCredentialStore(actor, database, options?.credentialKeys),
      mcp: createMcpStore(actor, database),
      modelConnections: {
        resolveForBot: (botId) => resolveModelSelection(actor, database, botId),
      },
    };
  }

  const steering = createSteeringMessageStore(actor, database);

  return {
    actor,
    membership: readMembership(actor, database),
    bots: {
      ...bots,
      create: (input) => createBot(actor, database, input),
      update: (id, patch) => updateBot(actor, database, id, patch),
      archive: (id) => archiveBot(actor, database, id),
      restore: (id) => restoreBot(actor, database, id),
      delete: (id) => deleteBot(actor, database, id),
      setAvatar: (id, avatarKey) => setBotAvatar(actor, database, id, avatarKey),
    },
    sections: {
      ...readSections(actor, database),
      create: (input) => createSection(actor, database, input),
      update: (id, patch) => updateSection(actor, database, id, patch),
      delete: (id) => deleteSection(actor, database, id),
    },
    threads: {
      ...threads,
      createForBot: (botId) => createThread(actor, database, botId),
      clear: (threadId) => clearThread(actor, database, threadId),
    },
    runs: {
      ...runs,
      create: (input) => createRunAndTask(actor, database, input),
      requestStop: (id) => requestRunStop(actor, database, id),
    },
    events,
    messages: {
      ...messages,
      steer: (input) => steering.steer(input),
    },
    toolResults: createToolResultReader(actor, database),
    routines: createRoutineStore(actor, database),
    notifications: createNotificationStore(actor, database),
    credentials: createEncryptedCredentialStore(actor, database, options?.credentialKeys),
    mcp: createMcpStore(actor, database),
    modelConnections: {
      ...readModelConnections(actor, database),
      create: (input) => createModelConnection(actor, database, input),
      update: (id, patch) => updateModelConnection(actor, database, id, patch),
      setDefault: (id) => setDefaultModelConnection(actor, database, id),
      delete: (id) => deleteModelConnection(actor, database, id),
    },
    memory: createMemoryStore(actor, database),
  };
}

function readBots(actor: Actor, database: Queryable): BotReader {
  return {
    async findById(id: string): Promise<BotRecord> {
      const { rows } = await database.query<BotRecord>(
        `select ${botColumns} from bot where id = $1 and space_id = $2`,
        [id, actor.spaceId],
      );

      return requiredRow(rows, "bot", id);
    },

    async list(scope: BotListScope = "active"): Promise<readonly BotRecord[]> {
      // One statement per scope rather than a string-built predicate, so the
      // archived filter is a value the reader chooses and never SQL a caller
      // can influence.
      const archived =
        scope === "active"
          ? "and archived_at is null"
          : scope === "archived"
            ? "and archived_at is not null"
            : "";

      const { rows } = await database.query<BotRecord>(
        `select ${botColumns} from bot where space_id = $1 ${archived} ` +
          "order by pinned desc, position asc, created_at asc, id asc",
        [actor.spaceId],
      );

      return rows;
    },
  };
}

/**
 * A section's name is unique per `(space, user)`, so both halves are the scope:
 * a section belongs to the user who named it, and another member of the space
 * cannot list, rename or delete it. v1.0 is a single-operator deployment, so
 * this is also the space's scope in practice; the rule is stated here because
 * the schema's unique index is the authority for it.
 */
function readSections(actor: UserActor, database: Queryable): SectionReader {
  return {
    async list(): Promise<readonly BotSectionRecord[]> {
      const { rows } = await database.query<BotSectionRecord>(
        `select ${botSectionColumns} from bot_section ` +
          "where space_id = $1 and user_id = $2 order by position asc, created_at asc, id asc",
        [actor.spaceId, actor.userId],
      );

      return rows;
    },
  };
}

function readThreads(actor: Actor, database: Queryable): ThreadReader {
  return {
    async findById(id: string): Promise<ThreadRecord> {
      const { rows } = await database.query<ThreadRecord>(
        `select ${threadColumns} from thread where id = $1 and space_id = $2`,
        [id, actor.spaceId],
      );

      return requiredRow(rows, "thread", id);
    },

    async listForBot(botId: string, page: ThreadPage): Promise<readonly ThreadRecord[]> {
      const values: unknown[] = [actor.spaceId, botId];
      let cursor = "";

      // The row comparison is the keyset: `(updated_at, id) < (cursor)` under
      // the same order the query sorts by, so the cursor names a position, not
      // an offset. Both halves are compared together, which is what makes the
      // order total even when two threads share an instant.
      if (page.before !== undefined) {
        values.push(page.before.updatedAt, page.before.id);
        cursor = ` and (updated_at, id) < ($3::timestamptz, $4::uuid)`;
      }

      values.push(page.limit);

      const { rows } = await database.query<ThreadRecord>(
        `select ${threadColumns} from thread ` +
          `where space_id = $1 and bot_id = $2${cursor} ` +
          `order by updated_at desc, id desc limit $${values.length}`,
        values,
      );

      return rows;
    },
  };
}

/**
 * The membership re-read: one statement against the authorization root, with
 * both halves bound from the actor. The row's absence is the shared
 * `NotFoundError`, so a caller cannot distinguish "revoked" from "never
 * existed" — and neither can a client.
 */
function readMembership(actor: UserActor, database: Queryable): MembershipReader {
  return {
    async requireActive(): Promise<void> {
      const { rows } = await database.query<{ readonly userId: string }>(
        "select user_id from space_member where space_id = $1 and user_id = $2",
        [actor.spaceId, actor.userId],
      );

      if (rows.length === 0) {
        throw new NotFoundError("space membership", actor.userId);
      }
    },
  };
}

function readRuns(actor: Actor, database: Queryable): RunReader {
  return {
    async findById(id: string): Promise<RunRecord> {
      const { rows } = await database.query<RunRecord>(
        `select ${runColumns} from run where id = $1 and space_id = $2`,
        [id, actor.spaceId],
      );

      return requiredRow(rows, "run", id);
    },

    async listForThread(threadId: string): Promise<readonly RunRecord[]> {
      const { rows } = await database.query<RunRecord>(
        `select ${runColumns} from run where space_id = $1 and thread_id = $2 ` +
          "order by created_at desc, id desc",
        [actor.spaceId, threadId],
      );

      return rows;
    },

    async findActiveForThread(threadId: string): Promise<RunRecord | undefined> {
      const { rows } = await database.query<RunRecord>(
        `select ${runColumns} from run where space_id = $1 and thread_id = $2 ` +
          "and status = any($3::run_status[]) " +
          "order by created_at desc, id desc limit 1",
        [actor.spaceId, threadId, ACTIVE_RUN_STATUSES],
      );

      return rows[0];
    },
  };
}

/**
 * The operator's stop command. An active run's `stop_requested_at` is set once
 * — `coalesce` keeps the first instant a second request found — and the run's
 * executor observes the mark, so this command changes no status itself. A run
 * that already finished is returned unchanged: stop is idempotent, and asking
 * again after the fact must not error on a run the operator can still see.
 * Only a missing or foreign run is the shared scoped not-found.
 */
async function requestRunStop(
  actor: UserActor,
  database: Queryable,
  runId: string,
): Promise<RunRecord> {
  const { rows } = await database.query<RunRecord>(
    "update run set stop_requested_at = coalesce(stop_requested_at, now()), updated_at = now() " +
      "where id = $1 and space_id = $2 and status = any($3::run_status[]) " +
      `returning ${runColumns}`,
    [runId, actor.spaceId, ACTIVE_RUN_STATUSES],
  );

  if (rows[0] !== undefined) {
    return rows[0];
  }

  const { rows: existing } = await database.query<RunRecord>(
    `select ${runColumns} from run where id = $1 and space_id = $2`,
    [runId, actor.spaceId],
  );

  return requiredRow(existing, "run", runId);
}

/**
 * The live run's command source (slice 6.7): the steering rows it claims and
 * the stop mark it observes, both scoped to the job's space. The seam is
 * declared in `@porkbot/effect` beside the session it feeds; this is its one
 * implementation over the rows.
 */
function createRunCommandSource(actor: SystemActor, database: Queryable): RunCommandSource {
  return {
    claimSteers: (runId) => claimSteeringMessages(actor, database, runId),
    async stopRequested(runId: string): Promise<boolean> {
      const { rows } = await database.query<{ readonly stopRequested: boolean }>(
        'select stop_requested_at is not null as "stopRequested" from run ' +
          "where id = $1 and space_id = $2",
        [runId, actor.spaceId],
      );

      return rows[0]?.stopRequested ?? false;
    },
  };
}

function readEvents(actor: Actor, database: Queryable): EventReader {
  return {
    async listAfter(
      threadId: string,
      afterSeq: number,
      limit: number,
    ): Promise<readonly EventRecord[]> {
      const { rows } = await database.query<EventRecord>(
        `select ${eventColumns} from event ` +
          "where space_id = $1 and thread_id = $2 and seq > $3 " +
          "order by seq asc limit $4",
        [actor.spaceId, threadId, afterSeq, limit],
      );

      return rows;
    },
  };
}

/**
 * Creates the bot or replays the one the spawn key already names.
 *
 * The section and the model connection are resolved inside the insert with
 * scoped joins: a selected row must belong to the actor's space, and when it
 * does not the statement writes nothing, so a cross-space reference can never
 * be assigned and there is no check-then-insert race. The empty result is then
 * reported as the reference missing — not-found, never forbidden. `on conflict
 * do update` is the replay: the conflicting insert touches only the key it
 * conflicted on and returns the existing row, so a resubmitted create is
 * answered by the first result and the replay does not re-validate the new
 * request's references — the row the key already names stands.
 */
async function createBot(actor: UserActor, database: Queryable, input: NewBot): Promise<BotRecord> {
  const sectionId = input.sectionId ?? null;
  const modelConnectionId = input.modelConnectionId ?? null;
  const { rows } = await database.query<BotRecord>(
    "insert into bot (space_id, user_id, name, title, description, instructions, color, " +
      "pinned, position, section_id, computer_id, model_connection_id, model, spawn_key) " +
      "select $1, $2, $3, $4, $5, $6, $7, $8, $9, s.id, $10, c.id, $11, $12 " +
      "from (values (1)) as anchor(n) " +
      "left join bot_section s on s.id = $13::uuid and s.space_id = $1 and s.user_id = $2 " +
      "left join model_connection c on c.id = $14::uuid and c.space_id = $1 " +
      "where ($13::uuid is null or s.id is not null) " +
      "and ($14::uuid is null or c.id is not null) " +
      "on conflict (space_id, spawn_key) do update set spawn_key = excluded.spawn_key " +
      `returning ${botColumns}`,
    [
      actor.spaceId,
      actor.userId,
      input.name,
      input.title ?? "",
      input.description ?? "",
      input.instructions ?? "",
      input.color,
      input.pinned ?? false,
      input.position ?? 0,
      input.computerId ?? null,
      input.model ?? null,
      input.spawnKey,
      sectionId,
      modelConnectionId,
    ],
  );

  // An empty insert means one of the scoped reference guards matched no row;
  // one read each names which. A missing reference and one in another space
  // are the same `NotFoundError`, as every scoped read reports them.
  if (rows[0] === undefined) {
    if (sectionId !== null) {
      const { rows: sectionRows } = await database.query<{ readonly id: string }>(
        "select id from bot_section where id = $1 and space_id = $2 and user_id = $3",
        [sectionId, actor.spaceId, actor.userId],
      );

      if (sectionRows[0] === undefined) {
        throw new NotFoundError("bot section", sectionId);
      }
    }

    if (modelConnectionId !== null) {
      const { rows: connectionRows } = await database.query<{ readonly id: string }>(
        "select id from model_connection where id = $1 and space_id = $2",
        [modelConnectionId, actor.spaceId],
      );

      if (connectionRows[0] === undefined) {
        throw new NotFoundError("model connection", modelConnectionId);
      }
    }
  }

  return insertedRow(rows);
}

async function updateBot(
  actor: UserActor,
  database: Queryable,
  id: string,
  patch: BotPatch,
): Promise<BotRecord> {
  const values: unknown[] = [];
  const assignments = ["updated_at = now()"];

  if (patch.name !== undefined) {
    values.push(patch.name);
    assignments.push(`name = $${values.length}`);
  }

  if (patch.title !== undefined) {
    values.push(patch.title);
    assignments.push(`title = $${values.length}`);
  }

  if (patch.description !== undefined) {
    values.push(patch.description);
    assignments.push(`description = $${values.length}`);
  }

  if (patch.instructions !== undefined) {
    values.push(patch.instructions);
    assignments.push(`instructions = $${values.length}`);
  }

  if (patch.color !== undefined) {
    values.push(patch.color);
    assignments.push(`color = $${values.length}`);
  }

  if (patch.pinned !== undefined) {
    values.push(patch.pinned);
    assignments.push(`pinned = $${values.length}`);
  }

  if (patch.position !== undefined) {
    values.push(patch.position);
    assignments.push(`position = $${values.length}`);
  }

  let sectionParameter: number | undefined;

  if (patch.sectionId !== undefined) {
    values.push(patch.sectionId);
    sectionParameter = values.length;
    assignments.push(`section_id = $${sectionParameter}`);
  }

  if (patch.computerId !== undefined) {
    values.push(patch.computerId);
    assignments.push(`computer_id = $${values.length}`);
  }

  let modelConnectionParameter: number | undefined;

  if (patch.modelConnectionId !== undefined) {
    values.push(patch.modelConnectionId);
    modelConnectionParameter = values.length;
    assignments.push(`model_connection_id = $${modelConnectionParameter}`);
  }

  if (patch.model !== undefined) {
    values.push(patch.model);
    assignments.push(`model = $${values.length}`);
  }

  values.push(id);
  const idParameter = values.length;
  values.push(actor.spaceId);
  const spaceParameter = values.length;

  // The section guard rides in the same statement that writes the column: a
  // section the actor does not own matches no row, so the update writes nothing
  // instead of filing the bot under a section it cannot see. The user parameter
  // is pushed only when the guard exists, so the placeholder count always
  // matches the statement.
  let userParameter: number | undefined;

  if (sectionParameter !== undefined) {
    values.push(actor.userId);
    userParameter = values.length;
  }

  const sectionGuard =
    sectionParameter === undefined || userParameter === undefined
      ? ""
      : ` and ($${sectionParameter}::uuid is null or exists (` +
        `select 1 from bot_section s where s.id = $${sectionParameter} ` +
        `and s.space_id = $${spaceParameter} and s.user_id = $${userParameter}))`;

  // The connection guard rides in the same statement for the same reason: a
  // connection the actor does not own matches no row, so the update writes
  // nothing rather than pointing a bot at another space's endpoint.
  const modelConnectionGuard =
    modelConnectionParameter === undefined
      ? ""
      : ` and ($${modelConnectionParameter}::uuid is null or exists (` +
        `select 1 from model_connection c where c.id = $${modelConnectionParameter} ` +
        `and c.space_id = $${spaceParameter}))`;

  const { rows } = await database.query<BotRecord>(
    `update bot set ${assignments.join(", ")} ` +
      `where id = $${idParameter} and space_id = $${spaceParameter}` +
      `${sectionGuard}${modelConnectionGuard} ` +
      `returning ${botColumns}`,
    values,
  );

  // An empty update with a reference in the patch is that reference's refusal
  // or the bot's absence; one scoped read each separates them so the caller
  // hears which.
  if (rows[0] === undefined && patch.sectionId !== undefined && patch.sectionId !== null) {
    const { rows: sectionRows } = await database.query<{ readonly id: string }>(
      "select id from bot_section where id = $1 and space_id = $2 and user_id = $3",
      [patch.sectionId, actor.spaceId, actor.userId],
    );

    if (sectionRows[0] === undefined) {
      throw new NotFoundError("bot section", patch.sectionId);
    }
  }

  if (
    rows[0] === undefined &&
    patch.modelConnectionId !== undefined &&
    patch.modelConnectionId !== null
  ) {
    const { rows: connectionRows } = await database.query<{ readonly id: string }>(
      "select id from model_connection where id = $1 and space_id = $2",
      [patch.modelConnectionId, actor.spaceId],
    );

    if (connectionRows[0] === undefined) {
      throw new NotFoundError("model connection", patch.modelConnectionId);
    }
  }

  return requiredRow(rows, "bot", id);
}

async function archiveBot(actor: UserActor, database: Queryable, id: string): Promise<BotRecord> {
  // `coalesce` keeps the first archival instant: archiving an archived bot is
  // the same state, not a new one, so a retry cannot rewrite its history.
  const { rows } = await database.query<BotRecord>(
    "update bot set archived_at = coalesce(archived_at, now()), updated_at = now() " +
      `where id = $1 and space_id = $2 returning ${botColumns}`,
    [id, actor.spaceId],
  );

  return requiredRow(rows, "bot", id);
}

async function restoreBot(actor: UserActor, database: Queryable, id: string): Promise<BotRecord> {
  const { rows } = await database.query<BotRecord>(
    "update bot set archived_at = null, updated_at = now() " +
      `where id = $1 and space_id = $2 returning ${botColumns}`,
    [id, actor.spaceId],
  );

  return requiredRow(rows, "bot", id);
}

async function deleteBot(actor: UserActor, database: Queryable, id: string): Promise<BotRecord> {
  const { rows } = await database.query<BotRecord>(
    `delete from bot where id = $1 and space_id = $2 returning ${botColumns}`,
    [id, actor.spaceId],
  );

  // Threads, tasks, runs and steering messages cascade at the database; the
  // avatar object in the storage seam is the caller's to delete, which is why
  // the removed row is returned.
  return requiredRow(rows, "bot", id);
}

async function setBotAvatar(
  actor: UserActor,
  database: Queryable,
  id: string,
  avatarKey: string | null,
): Promise<BotRecord> {
  const { rows } = await database.query<BotRecord>(
    "update bot set avatar_key = $1, updated_at = now() " +
      `where id = $2 and space_id = $3 returning ${botColumns}`,
    [avatarKey, id, actor.spaceId],
  );

  return requiredRow(rows, "bot", id);
}

function readModelConnections(actor: Actor, database: Queryable): ModelConnectionReader {
  return {
    async findById(id: string): Promise<ModelConnectionRecord> {
      const { rows } = await database.query<ModelConnectionRecord>(
        `select ${modelConnectionColumns} from model_connection where id = $1 and space_id = $2`,
        [id, actor.spaceId],
      );

      return requiredRow(rows, "model connection", id);
    },

    async list(): Promise<readonly ModelConnectionRecord[]> {
      // The default sorts first so an operator's settings list reads the same
      // way the resolver decides.
      const { rows } = await database.query<ModelConnectionRecord>(
        `select ${modelConnectionColumns} from model_connection where space_id = $1 ` +
          "order by is_default desc, label asc",
        [actor.spaceId],
      );

      return rows;
    },
  };
}

/**
 * Creates the connection or reports the label already in use. The conflict is
 * `do nothing` plus an explicit read of the result rather than a caught unique
 * violation, so the only unique index the insert can conflict on is the label;
 * the space's one-default index is not in play because a create never sets it.
 */
async function createModelConnection(
  actor: UserActor,
  database: Queryable,
  input: NewModelConnection,
): Promise<ModelConnectionRecord> {
  const { rows } = await database.query<ModelConnectionRecord>(
    "insert into model_connection (space_id, label, base_url, credential_name, default_model) " +
      "values ($1, $2, $3, $4, $5) on conflict (space_id, label) do nothing " +
      `returning ${modelConnectionColumns}`,
    [actor.spaceId, input.label, input.baseUrl, input.credentialName, input.defaultModel ?? null],
  );

  if (rows[0] === undefined) {
    throw new NameConflictError("model connection", input.label);
  }

  return insertedRow(rows);
}

async function updateModelConnection(
  actor: UserActor,
  database: Queryable,
  id: string,
  patch: ModelConnectionPatch,
): Promise<ModelConnectionRecord> {
  const values: unknown[] = [];
  const assignments = ["updated_at = now()"];

  if (patch.label !== undefined) {
    values.push(patch.label);
    assignments.push(`label = $${values.length}`);
  }

  if (patch.baseUrl !== undefined) {
    values.push(patch.baseUrl);
    assignments.push(`base_url = $${values.length}`);
  }

  if (patch.credentialName !== undefined) {
    values.push(patch.credentialName);
    assignments.push(`credential_name = $${values.length}`);
  }

  if (patch.defaultModel !== undefined) {
    values.push(patch.defaultModel);
    assignments.push(`default_model = $${values.length}`);
  }

  values.push(id);
  const idParameter = values.length;
  values.push(actor.spaceId);
  const spaceParameter = values.length;

  try {
    const { rows } = await database.query<ModelConnectionRecord>(
      `update model_connection set ${assignments.join(", ")} ` +
        `where id = $${idParameter} and space_id = $${spaceParameter} ` +
        `returning ${modelConnectionColumns}`,
      values,
    );

    return requiredRow(rows, "model connection", id);
  } catch (error) {
    if (patch.label !== undefined && isUniqueViolation(error)) {
      throw new NameConflictError("model connection", patch.label);
    }

    throw error;
  }
}

/**
 * Swaps the space's default connection. The scoped read first means an id that
 * is missing, or in another space, is a `NotFoundError` that leaves the
 * current default untouched.
 *
 * The clear-then-set order can never expose two defaults to the partial unique
 * index, only a brief window with none. Two concurrent swaps can interleave so
 * that the conditional set loses its race — the other writer's default is
 * present — so it clears and tries again a bounded number of times instead of
 * answering a 500 for a double-click. The final state is always exactly one
 * default: the last swap to land.
 */
async function setDefaultModelConnection(
  actor: UserActor,
  database: Queryable,
  id: string,
): Promise<ModelConnectionRecord> {
  const { rows: existing } = await database.query<{ readonly id: string }>(
    "select id from model_connection where id = $1 and space_id = $2",
    [id, actor.spaceId],
  );

  if (existing[0] === undefined) {
    throw new NotFoundError("model connection", id);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await database.query(
      "update model_connection set is_default = false, updated_at = now() " +
        "where space_id = $1 and is_default and id <> $2",
      [actor.spaceId, id],
    );

    const { rows } = await database.query<ModelConnectionRecord>(
      "update model_connection set is_default = true, updated_at = now() " +
        "where id = $1 and space_id = $2 and not exists (" +
        "select 1 from model_connection other where other.space_id = $2 " +
        "and other.is_default and other.id <> $1) " +
        `returning ${modelConnectionColumns}`,
      [id, actor.spaceId],
    );

    if (rows[0] !== undefined) {
      return rows[0];
    }
  }

  throw new Error("the space's default model connection did not settle; retry the request");
}

async function deleteModelConnection(
  actor: UserActor,
  database: Queryable,
  id: string,
): Promise<ModelConnectionRecord> {
  // Bots that selected the connection fall back to the space default: the
  // foreign key's `on delete set null` is what writes the fallback, so this
  // statement has nothing to repair by hand.
  const { rows } = await database.query<ModelConnectionRecord>(
    `delete from model_connection where id = $1 and space_id = $2 returning ${modelConnectionColumns}`,
    [id, actor.spaceId],
  );

  return requiredRow(rows, "model connection", id);
}

/**
 * The effective selection for one bot. The join resolves the connection with
 * `coalesce(bot's own, the space's one default)`, so a bot that selected no
 * connection follows the default and one that did is not affected by a later
 * default swap. The model is the same shape: the bot's own, else the
 * connection's `default_model`. An unset model on both sides filters the row
 * out, so the caller sees "nothing selected" instead of an empty model id.
 */
async function resolveModelSelection(
  actor: Actor,
  database: Queryable,
  botId: string,
): Promise<ModelSelection | undefined> {
  const { rows } = await database.query<ModelSelection>(
    'select c.id as "connectionId", c.base_url as "baseUrl", ' +
      'c.credential_name as "credentialName", ' +
      'coalesce(b.model, c.default_model) as "model" from bot b ' +
      "join model_connection c on c.space_id = b.space_id and c.id = coalesce(" +
      "b.model_connection_id, (select d.id from model_connection d " +
      "where d.space_id = b.space_id and d.is_default)) " +
      "where b.id = $1 and b.space_id = $2 " +
      "and coalesce(b.model, c.default_model) is not null",
    [botId, actor.spaceId],
  );

  return rows[0];
}

async function createSection(
  actor: UserActor,
  database: Queryable,
  input: NewBotSection,
): Promise<BotSectionRecord> {
  const { rows } = await database.query<BotSectionRecord>(
    "insert into bot_section (space_id, user_id, name, position) values ($1, $2, $3, $4) " +
      "on conflict (space_id, user_id, name) do nothing " +
      `returning ${botSectionColumns}`,
    [actor.spaceId, actor.userId, input.name, input.position ?? 0],
  );

  const section = rows[0];

  if (section === undefined) {
    // The only way this insert yields no row is the unique name, because the
    // actor supplies every other column.
    throw new NameConflictError("bot section", input.name);
  }

  return section;
}

async function updateSection(
  actor: UserActor,
  database: Queryable,
  id: string,
  patch: BotSectionPatch,
): Promise<BotSectionRecord> {
  const values: unknown[] = [];
  const assignments = ["updated_at = now()"];

  if (patch.name !== undefined) {
    values.push(patch.name);
    assignments.push(`name = $${values.length}`);
  }

  if (patch.position !== undefined) {
    values.push(patch.position);
    assignments.push(`position = $${values.length}`);
  }

  values.push(id);
  const idParameter = values.length;
  values.push(actor.spaceId);
  const spaceParameter = values.length;
  values.push(actor.userId);
  const userParameter = values.length;

  try {
    const { rows } = await database.query<BotSectionRecord>(
      `update bot_section set ${assignments.join(", ")} ` +
        `where id = $${idParameter} and space_id = $${spaceParameter} ` +
        `and user_id = $${userParameter} returning ${botSectionColumns}`,
      values,
    );

    return requiredRow(rows, "bot section", id);
  } catch (error) {
    if (patch.name !== undefined && isUniqueViolation(error)) {
      throw new NameConflictError("bot section", patch.name);
    }

    throw error;
  }
}

async function deleteSection(
  actor: UserActor,
  database: Queryable,
  id: string,
): Promise<BotSectionRecord> {
  const { rows } = await database.query<BotSectionRecord>(
    `delete from bot_section where id = $1 and space_id = $2 and user_id = $3 ` +
      `returning ${botSectionColumns}`,
    [id, actor.spaceId, actor.userId],
  );

  // The section's bots are not deleted: `bot.section_id` is `on delete set
  // null`, so they survive as unfiled.
  return requiredRow(rows, "bot section", id);
}

async function createThread(
  actor: UserActor,
  database: Queryable,
  botId: string,
): Promise<ThreadRecord> {
  const { rows } = await database.query<ThreadRecord>(
    "insert into thread (space_id, bot_id, user_id) " +
      `select $1, b.id, $2 from bot b where b.id = $3 and b.space_id = $1 returning ${threadColumns}`,
    [actor.spaceId, actor.userId, botId],
  );

  return requiredRow(rows, "bot", botId);
}
