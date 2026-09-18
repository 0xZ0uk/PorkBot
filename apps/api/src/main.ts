import { createLogger } from "@porkbot/logging";
import { createApiServer, moduleInfo } from "./index.ts";

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3001);
const server = createApiServer({ logger });

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  logger.info("api listening", { port });
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
