import process from "node:process";
import { Effect } from "effect";
import { createHealthServer, healthPath } from "@porkbot/health";
import { createLogger } from "@porkbot/logging";
import type { Runner } from "graphile-worker";
import { moduleInfo } from "./index.ts";
import type { RunExecutor } from "./jobs/run-execute.ts";
import { createRunExecutor } from "./run-execution.ts";
import { startWorker } from "./worker.ts";

/**
 * The worker process: the health probe every always-on service answers, and
 * the Graphile runner over the job registry.
 *
 * `DATABASE_URL` is the worker's own role's connection (`porkbot_worker`),
 * not the API's; the database decides what the process may read and write, and
 * the queue schema is the part only this role owns. The runner migrates that
 * schema on boot, so a fresh deployment needs the migrations applied (which
 * create the role and its grants) and nothing else.
 *
 * Signals are handled here rather than by Graphile: one shutdown path stops the
 * runner gracefully and then closes the health server, so an in-flight job is
 * awaited instead of killed.
 */

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3002);
const connectionString = process.env["DATABASE_URL"]?.trim();

if (connectionString === undefined || connectionString.length === 0) {
  logger.error("DATABASE_URL is not set; the worker has no queue to run", {});
  process.exit(1);
}

/**
 * The handler has atomically claimed the run before entering this seam, and the
 * harness owns the lease from then on: it heartbeats, interrupts the work on a
 * lost fence, and settles the run and its attempt. The model and tool runtime
 * that fills the work seam arrives with slice 6.9; until then the run records
 * its claim and completes with no output rather than pretending a runtime
 * exists.
 */
const verifiedRunExecutor: RunExecutor = createRunExecutor({
  work: ({ run, logger: runLogger }) =>
    Effect.sync(() => {
      runLogger.info("run claimed; no model runtime is wired yet", { fence: run.leaseFence });
    }),
});

let runner: Runner;

try {
  runner = await startWorker({ connectionString, executeRun: verifiedRunExecutor, logger });
} catch (error) {
  logger.error("worker failed to start", { error });
  process.exit(1);
}

const server = createHealthServer({ service: moduleInfo.name });

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  logger.info("worker listening", { port, path: healthPath });
});

let stopping = false;

function shutdown(signal: string): void {
  if (stopping) {
    return;
  }

  stopping = true;
  logger.info("worker stopping", { signal });

  void runner.stop(`received ${signal}`).finally(() => {
    server.close(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
