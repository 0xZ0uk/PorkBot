import { run } from "graphile-worker";
import type { Runner } from "graphile-worker";
import type { Logger } from "@porkbot/logging";
import { graphileLogger } from "./graphile-logger.ts";
import { createJobRegistry, defineJob } from "./job-registry.ts";
import { runExecuteJob } from "./jobs/run-execute.ts";
import type { RunExecutor } from "./jobs/run-execute.ts";

/**
 * Booting the worker: Graphile's runner plus the job registry, and nothing
 * else.
 *
 * The process connects with the worker's own database role (`porkbot_worker`),
 * so the queue's tables and the domain reads the handlers perform are checked
 * by the database rather than promised by this module. Graphile migrates its
 * own schema on boot, which is why the roles migration creates
 * `graphile_worker` and grants it to that role alone.
 *
 * Signals are handled by `main.ts`, not by Graphile (`noHandleSignals`), so one
 * shutdown path closes the health server and the runner together.
 */

export interface WorkerOptions {
  readonly connectionString: string;
  /**
   * What a verified run is handed to. Slice 6.1 ends at the fence check; 6.2's
   * claim and execution arrive through this seam without moving the handler.
   */
  readonly executeRun: RunExecutor;
  readonly logger: Logger;
  /** Jobs Graphile may run at once. Defaults to 4. */
  readonly concurrency?: number;
  /** How long Graphile waits between polls, in milliseconds. Defaults to 2 s. */
  readonly pollInterval?: number;
}

export async function startWorker(options: WorkerOptions): Promise<Runner> {
  const registry = createJobRegistry({
    jobs: [defineJob(runExecuteJob(options.executeRun))],
    logger: options.logger,
  });

  options.logger.info("worker jobs registered", { jobs: [...registry.identifiers] });

  return run({
    connectionString: options.connectionString,
    taskList: registry.taskList,
    concurrency: options.concurrency ?? 4,
    pollInterval: options.pollInterval ?? 2000,
    logger: graphileLogger(options.logger),
    noHandleSignals: true,
  });
}
