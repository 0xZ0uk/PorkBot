import type { Task } from "graphile-worker";
import type { Queryable } from "@porkbot/db";
import type { Logger } from "@porkbot/logging";

/**
 * The job registry: every durable background job the worker knows, and the
 * boundary between Graphile's queue and the domain.
 *
 * PRD decision 17 splits the two authorities deliberately, and this module is
 * where the split is visible:
 *
 *   - Graphile's job locking answers "which worker picks up the job". A job is
 *     handed to exactly one runner at a time, retries are scheduled by the
 *     queue, and a worker that dies has its lock expire.
 *   - The row fence answers "who owns the run". A job payload addresses a run;
 *     it does not carry the work, and it is never believed on its own. The
 *     handler re-reads the run through the `SystemActor` its payload names and
 *     acts only while the payload's fence still matches the row.
 *
 * Both are authoritative; neither substitutes for the other. A job that has
 * been reclaimed by Graphile after a crash is still refused by a run row whose
 * fence moved on, and a duplicate delivery is a no-op because the handler's
 * decision comes from the row, not from the delivery count. The handler itself
 * writes nothing — the fence's writer (slice 6.2's claim, deduped by the
 * attempt table's unique `(run_id, fence)`) is what makes the side effect
 * idempotent, and the re-read is what makes a superseded delivery harmless.
 *
 * This module is also where "payloads never carry the work" is enforced rather
 * than promised: a definition's `parse` must accept the payload as an object
 * with only its addressing fields, so a producer that tries to smuggle work
 * into a job fails at delivery, before a handler can read it.
 */

/** A payload a job definition refuses: the job fails rather than guesses. */
export class JobPayloadError extends Error {
  constructor(identifier: string, detail: string) {
    super(`the "${identifier}" job payload ${detail}`);
    this.name = "JobPayloadError";
  }
}

/**
 * What a handler is given besides its parsed payload. `jobId` is Graphile's
 * job id (the queue's identity, not the run's); `withPgClient` checks out one
 * connection from the runner's pool, so a handler's reads and writes travel on
 * the connection its role authenticated with.
 */
export interface JobContext {
  readonly jobId: string;
  /** Graphile's attempt counter: 1 on the first delivery, higher on a retry. */
  readonly attempt: number;
  readonly logger: Logger;
  readonly withPgClient: <Result>(work: (client: Queryable) => Promise<Result>) => Promise<Result>;
}

/** One job: its identifier, its payload parser, and its handler. */
export interface JobDefinition<Payload> {
  readonly identifier: string;
  /** Validates and narrows the delivered payload; throw `JobPayloadError` to refuse it. */
  readonly parse: (payload: unknown) => Payload;
  readonly handle: (payload: Payload, context: JobContext) => Promise<void>;
}

/** A definition with its payload type erased, so a registry can hold many. */
export interface RegisteredJob {
  readonly identifier: string;
  readonly run: (payload: unknown, context: JobContext) => Promise<void>;
}

/** Gives a job definition its erased registry shape without widening the handler. */
export function defineJob<Payload>(definition: JobDefinition<Payload>): RegisteredJob {
  return {
    identifier: definition.identifier,
    async run(payload, context): Promise<void> {
      await definition.handle(definition.parse(payload), context);
    },
  };
}

export interface JobRegistryOptions {
  readonly jobs: readonly RegisteredJob[];
  readonly logger: Logger;
}

export interface JobRegistry {
  readonly identifiers: readonly string[];
  /** Graphile's task list: every registered job, addressed by identifier. */
  readonly taskList: Record<string, Task>;
}

export function createJobRegistry(options: JobRegistryOptions): JobRegistry {
  const taskList: Record<string, Task> = {};

  for (const job of options.jobs) {
    if (Object.hasOwn(taskList, job.identifier)) {
      throw new Error(
        `the job identifier "${job.identifier}" is registered twice; one identifier is one handler.`,
      );
    }

    taskList[job.identifier] = async (payload, helpers) =>
      job.run(payload, {
        jobId: helpers.job.id,
        attempt: helpers.job.attempts,
        logger: options.logger.child({
          jobId: helpers.job.id,
          task: job.identifier,
        }),
        withPgClient: (work) => helpers.withPgClient((client) => work(client)),
      });
  }

  return { identifiers: Object.keys(taskList), taskList };
}
