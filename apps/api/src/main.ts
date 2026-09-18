import process from "node:process";
import { openDatabase, readDeploymentSettings } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { createApiServer, moduleInfo } from "./index.ts";
import { createDeploymentStatusService } from "./services/deployment.ts";

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3001);
const connectionString = process.env["DATABASE_URL"]?.trim();

if (connectionString === undefined || connectionString.length === 0) {
  logger.error("DATABASE_URL is not set; the api cannot serve its data-backed procedures", {});
  process.exit(1);
}

// The pool is lazy: constructing it opens no connection, so the process boots
// and answers its healthcheck while Postgres finishes coming up.
const database = openDatabase(connectionString);
const server = createApiServer({
  logger,
  services: {
    deployment: createDeploymentStatusService(() => readDeploymentSettings(database.database)),
  },
});

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  logger.info("api listening", { port });
});

process.on("SIGTERM", () => {
  server.close(() => {
    void database.close().then(() => process.exit(0));
  });
});
