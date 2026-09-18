import { decideReclaim, reclaimFailureMessage } from "@porkbot/core";
import { createRepositories, expiredLeaseReason } from "@porkbot/db";
import type { RunRecord, SystemActor, SystemRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import type { Logger } from "@porkbot/logging";
import { JobPayloadError } from "../job-registry.ts";
import type { JobDefinition } from "../job-registry.ts";
import { systemActorForJob } from "../system-actor.ts";

/**
 * The run-execute job: the worker's half of PRD decision 17, extended by slice
 * 6.3 to acquire a run three ways and to honour the reclaim rule.
 *
 * The payload addresses a run and states the fence the producer believed it was
 * holding; it carries no prompt, no model, no tool call and no checkpoint. The
 * handler never trusts it either: it re-reads the run through a `SystemActor`
 * for the payload's space, verifies the row's current fence, and only then
 * acquires the next fence.
 *
 * Three acquisitions are legitimate, in this order:
 *
 *   - `claim` takes a queued, unowned run — the fresh delivery.
 *   - `adopt` takes a live lease from exactly the owner named in the payload —
 *     the handoff from a watchdog that reclaimed a stranded run and is not
 *     itself an executor.
 *   - `reclaim` takes an active run whose lease has expired — a delivery that
 *     arrived while the previous owner was already gone.
 *
 * A fresh claim runs from scratch. An adopted or reclaimed run is a resume, and
 * PRD decision 25 applies: the stored checkpoint decides whether there is
 * anything to continue, and a run without one is failed with a typed reason
 * rather than silently restarted. The executor is told which case it is, so it
 * can rebuild its session from the checkpoint instead of composing a new one.
 *
 * Three properties fall out of the shape and are what make every registered job
 * idempotent by construction:
 *
 *   - A payload whose space does not own the run re-reads as not-found and
 *     exits, so a mis-addressed job cannot widen the actor's scope.
 *   - A payload whose fence no longer matches the row is a superseded delivery;
 *     it exits before the executor is called, so it has no side effects.
 *   - A duplicate delivery after the fence moved finds neither acquisition
 *     guard matching and exits; the second delivery's decision comes from the
 *     row, not from the delivery.
 */

/** The run-execute payload: addressing only, never work. */
export interface RunExecutePayload {
  readonly runId: string;
  readonly fence: number;
  readonly spaceId: string;
  /**
   * The exact owner handing the run over, present only on a watchdog resume.
   * It is the second half of the adopt guard; a fresh delivery leaves it out.
   */
  readonly owner?: string;
}

const runExecutePayloadKeys = new Set(["runId", "fence", "spaceId", "owner"]);

export const runExecuteIdentifier = "run.execute";

/** Reads a delivered payload, refusing anything but the addressing fields. */
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

  const owner = record["owner"];

  if (owner !== undefined && (typeof owner !== "string" || owner.trim() === "")) {
    throw new JobPayloadError(runExecuteIdentifier, 'needs a non-empty "owner" when it is present');
  }

  return {
    runId: requiredText(record, "runId"),
    fence,
    spaceId: requiredText(record, "spaceId"),
    ...(owner === undefined ? {} : { owner: owner.trim() }),
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
  /**
   * True when this execution continues a reclaimed run: the row's checkpoint
   * is the session state to resume from, never a fresh start.
   */
  readonly resumed: boolean;
}

/**
 * The execution seam is handed an acquired run and the `SystemActor`'s
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
        if (claimed !== undefined) {
          await executeRun({ actor, run: claimed, repositories, logger, resumed: false });
          return;
        }

        const adopted =
          payload.owner === undefined
            ? undefined
            : await repositories.runs.adopt(run.id, payload.fence, context.jobId, payload.owner);

        if (adopted !== undefined) {
          await resumeRun({ actor, run: adopted, repositories, logger }, executeRun);
          return;
        }

        const reclaimed = await repositories.runs.reclaim(run.id, payload.fence, context.jobId, {
          reason: expiredLeaseReason(run.leaseExpiresAt),
        });

        if (reclaimed === undefined) {
          logger.info("run job skipped: another worker owns the run", {
            payloadFence: payload.fence,
          });
          return;
        }

        await resumeRun({ actor, run: reclaimed, repositories, logger }, executeRun);
      });
    },
  };
}

/**
 * The reclaim rule (PRD decision 25): a reclaimed run resumes from its stored
 * checkpoint or is failed with a typed reason. The attempt this acquisition
 * recorded is settled as `failed` with the same reason, so a reclaimed run that
 * could not continue leaves no attempt running behind it.
 */
async function resumeRun(
  execution: Omit<RunExecution, "resumed">,
  executeRun: RunExecutor,
): Promise<void> {
  const decision = decideReclaim(execution.run.checkpoint);

  if (decision.resume) {
    await executeRun({ ...execution, resumed: true });
    return;
  }

  const lease = { owner: requiredOwner(execution.run), fence: execution.run.leaseFence };

  await execution.repositories.runs.update(execution.run.id, lease, {
    status: "failed",
    error: reclaimFailureMessage(decision.reason),
    errorCode: decision.reason,
    completed: true,
    attempt: "failed",
  });

  execution.logger.warn("run failed: there was nothing to resume", {
    fence: execution.run.leaseFence,
    reason: decision.reason,
  });
}

function requiredOwner(run: RunRecord): string {
  const owner = run.leaseOwner;

  if (owner === null) {
    throw new Error(`run ${run.id} was acquired without a lease owner`);
  }

  return owner;
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
