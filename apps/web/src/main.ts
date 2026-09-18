import { createLogger } from "@porkbot/logging";
import { createWebServer, moduleInfo } from "./index.ts";

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3000);
const server = createWebServer();

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  logger.info("web listening", { port });
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
