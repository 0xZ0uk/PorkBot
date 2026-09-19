import process from "node:process";
import { Effect } from "effect";
import {
  createEnvironmentCredentialStore,
  createHttpNotificationProvider,
  NotificationEmulator,
} from "@porkbot/adapters";
import { createHealthServer, healthPath } from "@porkbot/health";
import { createLogger } from "@porkbot/logging";
import type { Runner } from "graphile-worker";
import { moduleInfo } from "./index.ts";
import type { RunExecutor } from "./jobs/run-execute.ts";
import { createRunExecutor } from "./run-execution.ts";
import type { RunNotificationTarget } from "./run-notifications.ts";
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
 * The run-liveness notification target (slices 6.10 and 8.7): the E8 provider
 * and the origin a run's timeline link is built from.
 *
 * The emulator is the default, so the product records and holds notifications
 * with nothing configured — the mailbox is observable from a test and the
 * delivery path is the same one the webhook uses. A deployment that names a
 * webhook URL gets the HTTPS provider, whose key is read through the generic
 * environment credential store under a fixed name. The URL and the origin are
 * both checked at boot, so a typo fails loudly instead of delivering links
 * nobody can open. An unset origin falls back to the local web address with a
 * warning, because a link the operator cannot open is worth saying out loud.
 */
function createNotificationTarget(): RunNotificationTarget {
  const origin = resolveWebOrigin();
  const webhookUrl = process.env["PORKBOT_NOTIFICATION_WEBHOOK_URL"]?.trim() ?? "";

  if (webhookUrl === "") {
    logger.info("no notification webhook configured; the offline emulator holds deliveries", {});

    return { provider: new NotificationEmulator(), origin };
  }

  return {
    provider: createHttpNotificationProvider({
      endpoint: webhookUrl,
      credentialName: "PORKBOT_NOTIFICATION_WEBHOOK_KEY",
      credentials: createEnvironmentCredentialStore(process.env),
    }),
    origin,
  };
}

/**
 * The absolute origin a notification link is built from. A malformed value
 * throws so the process refuses to boot with links nobody can open, the same
 * direction an invalid rate limit or an unknown log level takes; an unset value
 * falls back to loopback with a warning, because the local stack really is
 * there and a deployment that cares will say so.
 */
function resolveWebOrigin(): string {
  const configured = process.env["PORKBOT_WEB_ORIGIN"]?.trim();

  if (configured === undefined || configured === "") {
    logger.warn("PORKBOT_WEB_ORIGIN is not set; notification links fall back to loopback", {
      fallback: "http://localhost:3000",
    });

    return "http://localhost:3000";
  }

  const url = new URL(configured);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`PORKBOT_WEB_ORIGIN must be an absolute http(s) origin, got "${url.protocol}"`);
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error("PORKBOT_WEB_ORIGIN must not carry embedded credentials");
  }

  return configured;
}

let notificationTarget: RunNotificationTarget;

try {
  notificationTarget = createNotificationTarget();
} catch (error) {
  logger.error("the notification configuration is invalid", { error });
  process.exit(1);
}

/**
 * The handler has atomically claimed the run before entering this seam, and the
 * harness owns the lease from then on: it heartbeats, interrupts the work on a
 * lost fence, and settles the run and its attempt. Slice 6.9 lands the
 * computer tools and proves a full run with real tool execution offline
 * (`offline-run.test.ts`); the live model launch that fills this seam with a
 * Pi-backed session waits on the stream bridge from Pi's agent loop to the
 * model runtime (slice 9.2 ships the runtime itself). Until then the run
 * records its claim and completes with no output rather than pretending a
 * runtime exists.
 */
const verifiedRunExecutor: RunExecutor = createRunExecutor({
  notificationTarget,
  work: ({ run, logger: runLogger }) =>
    Effect.sync(() => {
      runLogger.info("run claimed; no model runtime is wired yet", { fence: run.leaseFence });

      return { status: "completed" } as const;
    }),
});

let runner: Runner;

try {
  runner = await startWorker({
    connectionString,
    executeRun: verifiedRunExecutor,
    runNotifications: notificationTarget,
    logger,
  });
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
