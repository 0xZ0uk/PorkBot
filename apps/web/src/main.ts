import path from "node:path";
import process from "node:process";
import { createLogger } from "@porkbot/logging";
import { createStaticServer, moduleInfo, serviceName } from "./index.ts";

const logger = createLogger({ service: serviceName });
const requestedPort = Number(process.env["PORT"] ?? 3000);
const root = process.env["PORKBOT_WEB_ROOT"] ?? path.resolve(import.meta.dirname, "../client");

const server = createStaticServer({ root });

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  logger.info("web listening", { port, root, bundle: moduleInfo.name });
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
