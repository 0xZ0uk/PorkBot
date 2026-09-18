import type { Actor, SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { botColumns, eventColumns, runColumns, threadColumns } from "./records.ts";
import type { BotRecord, EventRecord, RunRecord, ThreadRecord } from "./records.ts";
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
import type { FencedRunPatch, ReclaimOptions, RunLease } from "./run-leases.ts";
import { insertedRow, requiredRow } from "./rows.ts";

export type {
  BotRecord,
  EventRecord,
  MessageRecord,
  MessageRole,
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
 * Runs are the exception to the one-method-per-write shape: the two commands
 * in `run-creation.ts` — message-triggered and routine-triggered — are the
 * only code paths in the package that insert a task or a run. Each builds its
 * rows in one transaction, so no caller has to remember the order or the
 * links, and the routine command settles the occurrence ledger in the same
 * transaction as the run it creates.
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
  readonly title?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly pinned?: boolean;
  readonly position?: number;
}

/** The mutable bot fields; an absent key is left untouched. */
export interface BotPatch {
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly color?: string;
  readonly pinned?: boolean;
  readonly position?: number;
}

export interface BotReader {
  /** Throws `NotFoundError` for a missing id and for one in another space alike. */
  findById(id: string): Promise<BotRecord>;
  list(): Promise<readonly BotRecord[]>;
}

export interface BotWriter {
  create(input: NewBot): Promise<BotRecord>;
  update(id: string, patch: BotPatch): Promise<BotRecord>;
}

export interface ThreadReader {
  findById(id: string): Promise<ThreadRecord>;
  listForBot(botId: string): Promise<readonly ThreadRecord[]>;
}

export interface ThreadWriter {
  /** Fails closed when the bot is outside the actor's space; nothing is inserted. */
  createForBot(botId: string): Promise<ThreadRecord>;
}

export interface RunReader {
  findById(id: string): Promise<RunRecord>;
  listForThread(threadId: string): Promise<readonly RunRecord[]>;
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
  heartbeat(id: string, lease: RunLease): Promise<RunRecord>;
  update(id: string, lease: RunLease, patch: FencedRunPatch): Promise<RunRecord>;
  /** Closes this fence's own attempt after ownership moved on; true when it did. */
  abandonAttempt(id: string, fence: number, reason: string): Promise<boolean>;
}

/** A job's scope: it may read the space its payload names and nothing else. */
export interface SystemRepositories {
  readonly actor: SystemActor;
  readonly bots: BotReader;
  readonly threads: ThreadReader;
  readonly runs: RunReader & SystemRunWriter;
  /** The scheduler's half: settle one routine slot through the job's space. */
  readonly routines: RoutineScheduler;
}

/** An operator's scope: reads plus the writes that carry a user of record. */
export interface UserRepositories {
  readonly actor: UserActor;
  readonly bots: BotReader & BotWriter;
  readonly threads: ThreadReader & ThreadWriter;
  readonly runs: RunReader & RunWriter;
  readonly events: EventReader;
  readonly routines: RoutineReader & RoutineWriter;
}

export type Repositories = UserRepositories | SystemRepositories;

export function createRepositories(actor: UserActor, database: Queryable): UserRepositories;
export function createRepositories(actor: SystemActor, database: Queryable): SystemRepositories;
export function createRepositories(actor: Actor, database: Queryable): Repositories;
export function createRepositories(actor: Actor, database: Queryable): Repositories {
  const bots = readBots(actor, database);
  const threads = readThreads(actor, database);
  const runs = readRuns(actor, database);
  const events = readEvents(actor, database);

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
        heartbeat: (id, lease) => heartbeatRun(actor, database, id, lease),
        update: (id, lease, patch) => updateClaimedRun(actor, database, id, lease, patch),
        abandonAttempt: (id, fence, reason) => abandonAttempt(actor, database, id, fence, reason),
      },
      routines: createRoutineStore(actor, database),
    };
  }

  return {
    actor,
    bots: {
      ...bots,
      create: (input) => createBot(actor, database, input),
      update: (id, patch) => updateBot(actor, database, id, patch),
    },
    threads: {
      ...threads,
      createForBot: (botId) => createThread(actor, database, botId),
    },
    runs: {
      ...runs,
      create: (input) => createRunAndTask(actor, database, input),
    },
    events,
    routines: createRoutineStore(actor, database),
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

    async list(): Promise<readonly BotRecord[]> {
      const { rows } = await database.query<BotRecord>(
        `select ${botColumns} from bot where space_id = $1 ` +
          "order by pinned desc, position asc, created_at asc, id asc",
        [actor.spaceId],
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

    async listForBot(botId: string): Promise<readonly ThreadRecord[]> {
      const { rows } = await database.query<ThreadRecord>(
        `select ${threadColumns} from thread where space_id = $1 and bot_id = $2 ` +
          "order by updated_at desc, id desc",
        [actor.spaceId, botId],
      );

      return rows;
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

async function createBot(actor: UserActor, database: Queryable, input: NewBot): Promise<BotRecord> {
  const { rows } = await database.query<BotRecord>(
    "insert into bot (space_id, user_id, name, title, description, instructions, color, " +
      "pinned, position, spawn_key) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) " +
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
      input.spawnKey,
    ],
  );

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

  values.push(id);
  const idParameter = values.length;
  values.push(actor.spaceId);
  const spaceParameter = values.length;

  const { rows } = await database.query<BotRecord>(
    `update bot set ${assignments.join(", ")} ` +
      `where id = $${idParameter} and space_id = $${spaceParameter} returning ${botColumns}`,
    values,
  );

  return requiredRow(rows, "bot", id);
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
