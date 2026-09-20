import { createLogger } from "@porkbot/logging";
import { createScreenCapabilityCodec } from "@porkbot/effect";
import { createComputerLifecycle } from "./computer-lifecycle.ts";
import { createComputerProviderSelection } from "./computer-provider.ts";
import type { ComputerProviderSelection } from "./computer-provider.ts";
import { moduleInfo } from "./index.ts";
import { createSupervisorServer } from "./server.ts";

/**
 * The supervisor's composition root (slice 7.1, PRD decision 20; slice 7.2 for
 * the provider choice).
 *
 * This process is the deployment's computer plane. It is the only one that
 * holds the Docker socket (the compose service mounts it; nothing else does),
 * and it is the only one that constructs a computer provider. Which provider
 * comes from `createComputerProviderSelection`: the offline emulator by
 * default, so the local stack runs with no daemon and no keys, and the Docker
 * provider when the deployment names an image. Every ceiling, endpoint and
 * idle window is validated there at boot — a misconfigured deployment refuses
 * to start with a clear log line instead of failing at a bot's first run.
 *
 * Boot order matters: the lifecycle surface starts listening first so the
 * container healthcheck can pass while reconciliation runs, and reconciliation
 * then adopts whatever the provider still holds from a previous process. A
 * provider that is unreachable at boot is logged and retried on the next
 * restart; it does not take the health surface down with it. The idle sweep
 * runs on a timer at a fraction of the idle window, parks machines no run is
 * using, and never touches a machine with a command in flight.
 */

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3003);
const serviceToken = process.env["PORKBOT_SUPERVISOR_TOKEN"]?.trim() ?? "";
const screenSecret = process.env["PORKBOT_SCREEN_TOKEN_SECRET"]?.trim() ?? "";

let selection: ComputerProviderSelection;

try {
  selection = createComputerProviderSelection();
} catch (error) {
  logger.error("the computer provider configuration is invalid; refusing to start", { error });
  process.exit(1);
}

const lifecycle = createComputerLifecycle({
  provider: selection.provider,
  idleTimeoutMs: selection.idleTimeoutMs,
});

/** The supervisor remains live while its provider is unavailable, but is not ready to receive work. */
const readiness = async (): Promise<boolean> => {
  if (serviceToken === "") {
    return false;
  }

  try {
    await selection.provider.validate();
    return true;
  } catch {
    return false;
  }
};

const server = createSupervisorServer({
  lifecycle,
  providers: {
    defaultKind: selection.kind,
    kinds: selection.kinds,
    validate: selection.validate,
  },
  serviceToken,
  screenTokens: screenSecret === "" ? undefined : createScreenCapabilityCodec(screenSecret),
  logger,
  serviceName: moduleInfo.name,
  readiness,
});

if (serviceToken === "") {
  logger.warn("PORKBOT_SUPERVISOR_TOKEN is not set; the lifecycle surface will refuse every call");
}

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;

  logger.info("supervisor listening", {
    port,
    computerProvider: selection.kind,
    computerProviders: selection.kinds,
    idleTimeoutMs: selection.idleTimeoutMs,
  });

  void lifecycle
    .reconcile()
    .then((report) => {
      logger.info("computer reconciliation finished", {
        listed: report.listed,
        adopted: report.adopted.length,
        failed: report.failed.map((entry) => ({
          computerId: entry.computer.computerId,
          detail: entry.detail,
        })),
      });
    })
    .catch((error: unknown) => {
      // A provider that cannot be listed is a deployment that needs an
      // operator, not a process that should stop serving its healthcheck.
      logger.error("computer reconciliation could not list the provider", { error });
    });
});

if (selection.idleTimeoutMs > 0) {
  const sweepMs = Math.max(1_000, Math.min(60_000, Math.floor(selection.idleTimeoutMs / 2)));
  const sweep = setInterval(() => {
    void lifecycle
      .stopIdle()
      .then((report) => {
        if (report.stopped.length === 0 && report.failed.length === 0) {
          return;
        }

        logger.info("computer idle sweep", {
          checked: report.checked,
          stopped: report.stopped.map((computer) => computer.computerId),
          failed: report.failed.map((entry) => ({
            computerId: entry.computer.computerId,
            detail: entry.detail,
          })),
        });
      })
      .catch((error: unknown) => {
        logger.error("computer idle sweep could not list the provider", { error });
      });
  }, sweepMs);

  // The HTTP server owns the process lifetime; the sweep must not hold it open.
  sweep.unref();
}

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
