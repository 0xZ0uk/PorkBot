import { createRepositories } from "@porkbot/db";
import type { RunRecord, SystemActor, SystemRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import type { Logger } from "@porkbot/logging";
import { JobPayloadError } from "../job-registry.ts";
import type { JobDefinition } from "../job-registry.ts";
import { systemActorForJob } from "../system-actor.ts";

/**
 * The run-execute job: the worker's half of PRD decision 17.
 *
 * The payload addresses a run and states the fence the producer believed it was
 * holding; it carries no prompt, no model, no tool call and no checkpoint. The
 * handler never trusts it either: it re-reads the run through a `SystemActor`
 * for the payload's space, verifies the row's current fence, and atomically
 * claims the next fence before handing work to the executor.
 *
 * Three properties fall out of that shape:
 *
 *   - A payload whose space does not own the run re-reads as not-found and
 *     exits, so a mis-addressed job cannot widen the actor's scope.
 *   - A payload whose fence no longer matches the row is a superseded delivery;
 *     it exits before the executor is called, so it has no side effects.
 *   - A duplicate delivery after the fence moved is the same no-op, which is
 *     what makes every registered job idempotent by construction: the second
 *     delivery's decision comes from the row, not from the delivery.
 *
 * The executor therefore receives a claimed run. Heartbeats and all execution
 * writes use that returned owner/fence through the same scoped repository.
 */

/** The run-execute payload: addressing only, never work. */
export interface RunExecutePayload {
  readonly runId: string;
  readonly fence: number;
  readonly spaceId: string;
}

const runExecutePayloadKeys = new Set(["runId", "fence", "spaceId"]);

export const runExecuteIdentifier = "run.execute";

/** Reads a delivered payload, refusing anything but the three addressing fields. */
export function parseRunExecutePayload(payload: unknown): RunExecutePayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new JobPayloadError(runExecuteIdentifier, "must be an object");
  }

  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!runExecutePayloadKeys.has(key)) {
      throw new JobPayloadError(
        runExecuteIdentifier,
        `carries "${key}"; a job payload addresses the run and never carries work`,
      );
    }
  }

  const fence = record["fence"];

  if (typeof fence !== "number" || !Number.isInteger(fence) || fence < 0) {
    throw new JobPayloadError(runExecuteIdentifier, 'needs a non-negative integer "fence"');
  }

  return {
    runId: requiredText(record, "runId"),
    fence,
    spaceId: requiredText(record, "spaceId"),
  };
}

function requiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string" || value.trim() === "") {
    throw new JobPayloadError(runExecuteIdentifier, `needs a non-empty "${key}"`);
  }

  return value.trim();
}

/** The run row, its scope and its repositories, once the fence has been checked. */
export interface RunExecution {
  readonly actor: SystemActor;
  readonly run: RunRecord;
  readonly repositories: SystemRepositories;
  readonly logger: Logger;
}

/**
 * The execution seam is handed an atomically claimed run and the `SystemActor`'s
 * repositories, never a raw connection, so every later write must go through
 * the claimed run's owner and fence without stepping outside the job's space.
 */
export type RunExecutor = (execution: RunExecution) => Promise<void>;

export function runExecuteJob(executeRun: RunExecutor): JobDefinition<RunExecutePayload> {
  return {
    identifier: runExecuteIdentifier,
    parse: parseRunExecutePayload,
    async handle(payload, context): Promise<void> {
      const logger = context.logger.child({ runId: payload.runId });

      await context.withPgClient(async (client) => {
        const actor = systemActorForJob({ jobId: context.jobId, spaceId: payload.spaceId });
        const repositories = createRepositories(actor, client);
        const run = await findRun(repositories, payload.runId, logger);

        if (run === undefined) {
          return;
        }

        if (run.leaseFence !== payload.fence) {
          logger.info("run job skipped: the row fence moved on", {
            payloadFence: payload.fence,
            rowFence: run.leaseFence,
          });
          return;
        }

        const claimed = await repositories.runs.claim(run.id, payload.fence, context.jobId);
        if (claimed === undefined) {
          logger.info("run job skipped: another worker owns the run", {
            payloadFence: payload.fence,
          });
          return;
        }

        await executeRun({ actor, run: claimed, repositories, logger });
      });
    },
  };
}

/**
 * The scoped read, with "not found" as an outcome rather than an error: a run
 * in another space and a run that does not exist are the same not-found, and
 * both mean this delivery has nothing to do.
 */
async function findRun(
  repositories: SystemRepositories,
  runId: string,
  logger: Logger,
): Promise<RunRecord | undefined> {
  try {
    return await repositories.runs.findById(runId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      logger.info("run job skipped: the run is not in the job's space", {});
      return undefined;
    }

    throw error;
  }
}
