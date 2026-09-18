import type { Actor, SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { botColumns, runColumns, threadColumns } from "./records.ts";
import type { BotRecord, RunRecord, ThreadRecord } from "./records.ts";
import { createRunAndTask } from "./run-creation.ts";
import type { CreatedRunAndTask, NewRunAndTask } from "./run-creation.ts";
import { insertedRow, requiredRow } from "./rows.ts";

export type {
  BotRecord,
  MessageRecord,
  MessageRole,
  RunRecord,
  TaskRecord,
  TaskStatus,
  ThreadRecord,
} from "./records.ts";

/**
 * The actor-scoped repository layer: the only way `packages/db` touches tenant
 * rows. The one deliberate exception is `readDeploymentSettings`, which reads
 * the deployment-global configuration before an actor can exist; it takes no
 * tenant id and returns no tenant data, so it is not a second scoping path.
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
 * The factory hands a `UserActor` write capabilities and a `SystemActor` reads
 * only: a row that must carry a user (`bot.user_id`, `thread.user_id`) cannot
 * be created without an actor that *is* a user, and a job has no user to
 * borrow. Slice 6.2 adds the system writes that carry no user — run claims and
 * heartbeats — to `SystemRepositories`.
 *
 * Runs are the exception to the one-method-per-write shape: `runs.create` is
 * the single run-creation command from `run-creation.ts`, and it is the only
 * code path in the package that inserts a run. It builds the user message, the
 * task and the run in one transaction, so no caller has to remember the order
 * or the links.
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

/** A job's scope: it may read the space its payload names and nothing else. */
export interface SystemRepositories {
  readonly actor: SystemActor;
  readonly bots: BotReader;
  readonly threads: ThreadReader;
  readonly runs: RunReader;
}

/** An operator's scope: reads plus the writes that carry a user of record. */
export interface UserRepositories {
  readonly actor: UserActor;
  readonly bots: BotReader & BotWriter;
  readonly threads: ThreadReader & ThreadWriter;
  readonly runs: RunReader & RunWriter;
}

export type Repositories = UserRepositories | SystemRepositories;

export function createRepositories(actor: UserActor, database: Queryable): UserRepositories;
export function createRepositories(actor: SystemActor, database: Queryable): SystemRepositories;
export function createRepositories(actor: Actor, database: Queryable): Repositories;
export function createRepositories(actor: Actor, database: Queryable): Repositories {
  const bots = readBots(actor, database);
  const threads = readThreads(actor, database);
  const runs = readRuns(actor, database);

  if (actor.kind === "system") {
    return { actor, bots, threads, runs };
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
