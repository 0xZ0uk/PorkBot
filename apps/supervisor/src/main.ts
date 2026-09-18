import { createHealthServer, healthPath } from "@porkbot/health";
import { createLogger } from "@porkbot/logging";
import { moduleInfo } from "./index.ts";

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3003);
const server = createHealthServer({ service: moduleInfo.name });

logger.info("supervisor idle");

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  logger.info("supervisor listening", { port, path: healthPath });
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
