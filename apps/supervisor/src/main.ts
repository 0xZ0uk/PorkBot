import { createLogger } from "@porkbot/logging";
import { ComputerEmulator } from "@porkbot/adapters";
import { createScreenCapabilityCodec } from "@porkbot/effect";
import { createComputerLifecycle } from "./computer-lifecycle.ts";
import { moduleInfo } from "./index.ts";
import { createSupervisorServer } from "./server.ts";

/**
 * The supervisor's composition root (slice 7.1, PRD decision 20).
 *
 * This process is the deployment's computer plane. It is the only one that
 * will hold the Docker socket (the compose service mounts it; nothing else
 * does), and it is the only one that constructs a computer provider. Until the
 * Docker provider lands in slice 7.2 the provider is the offline emulator —
 * the seam's third implementation — so the process boots, answers its
 * healthcheck and exercises the whole lifecycle surface with no daemon state
 * to corrupt. Slice 7.2 replaces the construction below with the Docker
 * provider; nothing else in this process changes.
 *
 * Boot order matters: the lifecycle surface starts listening first so the
 * container healthcheck can pass while reconciliation runs, and reconciliation
 * then adopts whatever the provider still holds from a previous process. A
 * provider that is unreachable at boot is logged and retried on the next
 * restart; it does not take the health surface down with it.
 */

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3003);
const serviceToken = process.env["PORKBOT_SUPERVISOR_TOKEN"]?.trim() ?? "";
const screenSecret = process.env["PORKBOT_SCREEN_TOKEN_SECRET"]?.trim() ?? "";

const lifecycle = createComputerLifecycle({ provider: new ComputerEmulator() });
const server = createSupervisorServer({
  lifecycle,
  serviceToken,
  screenTokens: screenSecret === "" ? undefined : createScreenCapabilityCodec(screenSecret),
  logger,
  serviceName: moduleInfo.name,
});

if (serviceToken === "") {
  logger.warn("PORKBOT_SUPERVISOR_TOKEN is not set; the lifecycle surface will refuse every call");
}

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  logger.info("supervisor listening", { port });

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

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
