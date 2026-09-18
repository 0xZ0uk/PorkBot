import process from "node:process";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { openDatabase, readDeploymentSettings } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { createApiServer, moduleInfo } from "./index.ts";
import { limitsFromEnvironment } from "./limits.ts";
import type { LimitsConfig } from "./limits.ts";
import { createDeploymentStatusService } from "./services/deployment.ts";

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3001);
const connectionString = process.env["DATABASE_URL"]?.trim();

if (connectionString === undefined || connectionString.length === 0) {
  logger.error("DATABASE_URL is not set; the api cannot serve its data-backed procedures", {});
  process.exit(1);
}

// An invalid limit fails startup rather than silently guarding with a value
// nobody chose, the same direction an unknown LOG_LEVEL refuses to boot.
let limits: LimitsConfig;

try {
  limits = limitsFromEnvironment(process.env);
} catch (error) {
  logger.error("the rate limit configuration is invalid", { error });
  process.exit(1);
}

// The pool is lazy: constructing it opens no connection, so the process boots
// and answers its healthcheck while Postgres finishes coming up.
const database = openDatabase(connectionString);
const server = createApiServer({
  logger,
  limits,
  services: {
    deployment: createDeploymentStatusService(() => readDeploymentSettings(database.database)),
    realtime: new InProcessRealtimeFanout(),
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
