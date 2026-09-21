import { findQueuedRunDispatches } from "@porkbot/db";
import type { Queryable } from "@porkbot/db";
import type { Logger } from "@porkbot/logging";
import type { Runner } from "graphile-worker";
import { runExecuteIdentifier } from "./jobs/run-execute.ts";

/** Message-triggered commands should reach Graphile within one poll. */
export const runDispatchIntervalMs = 1_000;

export interface RunDispatchOptions {
  readonly database: Queryable;
  readonly queue: Pick<Runner, "addJob">;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface RunDispatcher {
  stop(): Promise<void>;
}

/**
 * Reconciles one batch of durable queued runs into Graphile deliveries. The
 * run id is the job key, so a pass racing an existing delivery replaces the
 * address rather than creating a second execution. The run's fence remains
 * the authority when the handler claims it.
 */
export async function dispatchQueuedRunBatch(
  options: Pick<RunDispatchOptions, "database" | "queue" | "logger">,
): Promise<number> {
  const queued = await findQueuedRunDispatches(options.database);

  for (const run of queued) {
    await options.queue.addJob(
      runExecuteIdentifier,
      { runId: run.runId, fence: run.fence, spaceId: run.spaceId },
      { jobKey: `${runExecuteIdentifier}:${run.runId}`, jobKeyMode: "replace" },
    );
  }

  if (queued.length > 0) {
    options.logger.info("queued runs dispatched", { count: queued.length });
  }

  return queued.length;
}

/**
 * Starts the worker-side outbox reconciliation. A pass schedules the next only
 * after it finishes, so a slow database cannot stack overlapping scans. Runs
 * remain durable while the process is down and the immediate first pass picks
 * them up on restart.
 */
export function startRunDispatcher(options: RunDispatchOptions): RunDispatcher {
  const intervalMs = options.intervalMs ?? runDispatchIntervalMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> = Promise.resolve();

  const runPass = async (): Promise<void> => {
    try {
      await dispatchQueuedRunBatch(options);
    } catch (error) {
      options.logger.error("queued run dispatch failed", { error });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          active = runPass();
        }, intervalMs);
      }
    }
  };

  active = runPass();

  return {
    async stop(): Promise<void> {
      stopped = true;

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      await active;
    },
  };
}
