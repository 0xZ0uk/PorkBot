import process from "node:process";
import { createBackupLedger, createBackupStatusReader, openDatabase, queryable } from "@porkbot/db";
import type { DatabaseHandle } from "@porkbot/db";
import { createHealthServer, livenessPath, readinessPath } from "@porkbot/health";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { createBackupArchive } from "./archive.ts";
import { keyringKeyIds } from "./cipher.ts";
import { loadBackupConfig } from "./config.ts";
import type { BackupConfig } from "./config.ts";
import { writeKeyEnvelope } from "./envelope.ts";
import { backupErrorDetail } from "./errors.ts";
import { readBackupEnvironment } from "./environment.ts";
import { moduleInfo } from "./index.ts";
import { createPostgresTools } from "./postgres.ts";
import { performBackupRun } from "./run.ts";
import { createBackupScheduler } from "./scheduler.ts";

/**
 * The backup process (slice 12.3; PRD story 5).
 *
 * A sixth always-on process beside the API, the worker, the web and the
 * supervisor, and the only one that holds a database connection with dump
 * rights. It owns the nightly run and the monthly restore drill, and nothing
 * else: no HTTP surface beyond the health probe, no agent-facing path, no
 * provider credential except the S3 keys it resolves per request.
 *
 * The loop asks the ledger whether a run is due once a minute. The first tick
 * runs on boot — a fresh deployment should have a backup before its first
 * night, and a process that restarted after a missed window should catch up
 * immediately — and a restart after a completed run finds nothing due.
 *
 * The key envelope is written at boot and after every run, so the recovery
 * artifact tracks the keyring the deployment is actually using.
 *
 * Signals close the loop, the health server and the database handle in one
 * path, so a shutdown mid-run waits for the run to settle rather than killing
 * it.
 */

const logger = createLogger({ service: moduleInfo.name });

let config: BackupConfig;

try {
  config = loadBackupConfig(readBackupEnvironment(), logger);
} catch (error) {
  logger.error("the backup configuration is invalid", { detail: backupErrorDetail(error) });
  process.exit(1);
}

const handle: DatabaseHandle = openDatabase(config.connectionString);
const database = queryable(handle);
const ledger = createBackupLedger(database);
const reader = createBackupStatusReader(database);
const archive = createBackupArchive({ storage: config.destination, keyring: config.keyring });
const postgres = createPostgresTools();

logger.info("backup process configured", {
  keyIds: keyringKeyIds(config.keyring),
  schedule: `${String(config.schedule.hourUtc).padStart(2, "0")}:${String(config.schedule.minuteUtc).padStart(2, "0")} UTC`,
  retentionDays: config.retentionDays,
  drillIntervalDays: config.drillIntervalDays,
});

async function writeEnvelope(scheduleLogger: Logger): Promise<void> {
  try {
    await writeKeyEnvelope(config.envelopePath, config.keyring, config.envelopePassphrase);
    scheduleLogger.info("the sealed key envelope is written", { path: config.envelopePath });
  } catch (error) {
    // A backup that cannot write its recovery artifact is still a backup, but
    // the operator has to hear that the artifact is stale.
    scheduleLogger.error("could not write the sealed key envelope", {
      path: config.envelopePath,
      detail: backupErrorDetail(error),
    });
  }
}

const scheduler = createBackupScheduler({
  reader,
  logger,
  schedule: config.schedule,
  run: async (previous) => {
    await performBackupRun(
      {
        ledger,
        archive,
        homes: config.homes,
        postgres,
        connectionString: config.connectionString,
        logger,
        retentionDays: config.retentionDays,
        drillIntervalDays: config.drillIntervalDays,
        now: () => new Date(),
      },
      previous,
    );

    await writeEnvelope(logger);
  },
});

await writeEnvelope(logger);

const server = createHealthServer({
  service: moduleInfo.name,
  // Readiness is "the ledger is reachable": a lost database flips `/readyz`
  // without taking down `/livez`, and a backup that cannot reach its ledger
  // has nothing to record. A failed run does not make the process unready —
  // the worker's watchdog is what alerts on that.
  readiness: async () => {
    try {
      await database.query("select 1");

      return true;
    } catch {
      return false;
    }
  },
});

server.listen(config.port, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.port;

  logger.info("backup process listening", { port, livenessPath, readinessPath });
});

let running = false;
let inFlight: Promise<void> | undefined;

async function tick(): Promise<void> {
  if (running) {
    return;
  }

  running = true;
  inFlight = (async () => {
    try {
      await scheduler.tick();
    } catch (error) {
      // A tick that could not even reach the ledger is logged and retried next
      // minute; the worker's watchdog is what alerts on a gap.
      logger.error("a backup tick failed before it could run", {
        detail: backupErrorDetail(error),
      });
    } finally {
      running = false;
    }
  })();

  await inFlight;
}

const timer = setInterval(() => void tick(), config.tickMs);

timer.unref();

void tick();

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }

  stopping = true;
  logger.info("backup process stopping", { signal });
  clearInterval(timer);

  // A run in flight is awaited before the pool closes: a backup that is
  // already streaming a dump settles rather than dying with the process.
  await inFlight?.catch(() => undefined);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await handle.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
