import process from "node:process";
import {
  createEnvironmentCredentialStore,
  createHttpNotificationProvider,
  NotificationEmulator,
} from "@porkbot/adapters";
import { credentialKeyringFromEnvironment, openDatabase, queryable } from "@porkbot/db";
import type { CredentialKeyring } from "@porkbot/db";
import { createHealthServer, livenessPath } from "@porkbot/health";
import { createLogger } from "@porkbot/logging";
import type { Runner } from "graphile-worker";
import { moduleInfo } from "./index.ts";
import type { RunExecutor } from "./jobs/run-execute.ts";
import { createLiveRunWork } from "./live-run.ts";
import { createRunExecutor } from "./run-execution.ts";
import { startRunDispatcher } from "./run-dispatch.ts";
import type { RunDispatcher } from "./run-dispatch.ts";
import type { RunNotificationTarget } from "./run-notifications.ts";
import { startWorker } from "./worker.ts";

/**
 * The worker process: separate liveness and dependency-readiness probes for
 * every always-on service, and the Graphile runner over the job registry.
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

// Graphile owns the queue connection. This small process-scoped handle carries
// the readiness probe and the run-dispatch scan, so a lost database flips
// `/readyz` without taking down `/livez` or making the worker guess from the
// runner's in-memory state. Its cap is the budget's `workerReadiness` entry
// (slice 14.6): one statement at a time.
const readinessDatabase = openDatabase(connectionString, "workerReadiness");
let workerReady = false;

const credentialKeys = readCredentialKeys();

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
 * lost fence, and settles the run and its attempt. The work is the live model
 * launch (slice 6.11): it resolves the run's bot, conversation, model
 * connection and memory lane, composes the prompt, drives the live agent loop
 * and records the session's events through the one recorder. `usage` rides the
 * job's repository as the run's own ledger write (slice 8.8), and a run that
 * cannot be assembled fails with the sentence its operator can act on instead
 * of completing with no output.
 */
const verifiedRunExecutor: RunExecutor = createRunExecutor({
  notificationTarget,
  work: createLiveRunWork(),
});

let runner: Runner | undefined;
let runDispatcher: RunDispatcher | undefined;

const server = createHealthServer({
  service: moduleInfo.name,
  readiness: async () => {
    if (!workerReady) {
      return false;
    }

    try {
      await queryable(readinessDatabase).query("select 1");
      return true;
    } catch {
      return false;
    }
  },
});

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  logger.info("worker listening", { port, path: livenessPath });
});

try {
  runner = await startWorker({
    connectionString,
    executeRun: verifiedRunExecutor,
    runNotifications: notificationTarget,
    // Deployment-health alerts ride the same provider but skip the
    // per-user preference check: a missed backup is not a notification
    // category an operator opts into.
    operatorAlerts: notificationTarget.provider,
    ...(credentialKeys === undefined ? {} : { credentialKeys }),
    logger,
  });
  runDispatcher = startRunDispatcher({
    database: queryable(readinessDatabase),
    queue: runner,
    logger,
  });
  workerReady = true;
} catch (error) {
  logger.error("worker failed to start", { error });
  process.exit(1);
}

let stopping = false;

function shutdown(signal: string): void {
  if (stopping) {
    return;
  }

  stopping = true;
  logger.info("worker stopping", { signal });

  void (runDispatcher === undefined ? Promise.resolve() : runDispatcher.stop())
    .then(() => (runner === undefined ? Promise.resolve() : runner.stop(`received ${signal}`)))
    .finally(() => {
      void readinessDatabase.close().finally(() => {
        server.close(() => process.exit(0));
      });
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/** Invalid or absent keys lock live runs without taking down health checks. */
function readCredentialKeys(): CredentialKeyring | undefined {
  try {
    return credentialKeyringFromEnvironment(process.env);
  } catch (error) {
    logger.warn("PORKBOT_CREDENTIAL_KEYS is not usable; live runs cannot resolve credentials", {
      error,
    });

    return undefined;
  }
}
