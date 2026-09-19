import process from "node:process";
import {
  createEnvironmentCredentialStore,
  createHttpMcpServerProvider,
  createSupervisorComputerProvider,
  InProcessRealtimeFanout,
  LocalStorageProvider,
} from "@porkbot/adapters";
import {
  createIngressStore,
  createRepositories,
  credentialKeyringFromEnvironment,
  openDatabase,
  queryable,
  readDeploymentSettings,
} from "@porkbot/db";
import type { CredentialKeyring } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { createApiServer, moduleInfo } from "./index.ts";
import { limitsFromEnvironment } from "./limits.ts";
import type { LimitsConfig } from "./limits.ts";
import { createDeploymentStatusService } from "./services/deployment.ts";
import { createMcpService, mcpCallbackPath } from "./services/mcp.ts";
import { createWebhookIngress } from "./webhooks.ts";
import type { WebhookHandler } from "./webhooks.ts";

const logger = createLogger({ service: moduleInfo.name });
const requestedPort = Number(process.env["PORT"] ?? 3001);
const connectionString = process.env["DATABASE_URL"]?.trim();

if (connectionString === undefined || connectionString.length === 0) {
  logger.error("DATABASE_URL is not set; the api cannot serve its data-backed procedures", {});
  process.exit(1);
}

// Avatar bytes need one home. The local provider is the self-hosting default
// (slice 7.7 adds the S3-compatible one), and the root is required rather than
// defaulted: a process that guessed a path would silently write a bot's files
// somewhere an operator never declared or backed up.
const storageRoot = process.env["PORKBOT_STORAGE_DIR"]?.trim();

if (storageRoot === undefined || storageRoot.length === 0) {
  logger.error("PORKBOT_STORAGE_DIR is not set; bot avatars have no storage root", {});
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

// The credential keyring is optional at boot: without it the encrypted store
// is locked (a typed 503 at every credential and MCP call), and the process
// still serves everything that does not touch a secret.
const credentialKeys = readCredentialKeys();

// The OAuth callback's absolute URL. A self-hosted deployment reaches its own
// API on loopback unless the operator names a public origin; the value is what
// the authorization server redirects the browser back to, so an unset value is
// worth saying out loud — a provider may refuse an http redirect, and a local
// default is not a public origin.
const configuredCallbackUrl = process.env["PORKBOT_MCP_CALLBACK_URL"]?.trim();
const mcpCallbackUrl =
  configuredCallbackUrl ?? `http://localhost:${String(requestedPort)}${mcpCallbackPath}`;

if (configuredCallbackUrl === undefined) {
  logger.warn("PORKBOT_MCP_CALLBACK_URL is not set; OAuth callbacks fall back to loopback http", {
    path: mcpCallbackPath,
  });
}

// The computer boundary (slice 7.1): the API talks to the supervisor's
// authenticated surface and never holds the Docker socket or a provider
// credential. Without the pair, the computer procedures answer the typed
// SERVICE_UNAVAILABLE instead of pretending a machine is gone, and the rest of
// the API is unaffected.
const supervisorUrl = process.env["PORKBOT_SUPERVISOR_URL"]?.trim();
const supervisorToken = process.env["PORKBOT_SUPERVISOR_TOKEN"]?.trim();
const computers =
  supervisorUrl === undefined ||
  supervisorUrl === "" ||
  supervisorToken === undefined ||
  supervisorToken === ""
    ? undefined
    : createSupervisorComputerProvider({ baseUrl: supervisorUrl, token: supervisorToken });

if (computers === undefined) {
  logger.warn("PORKBOT_SUPERVISOR_URL or PORKBOT_SUPERVISOR_TOKEN is not set", {
    consequence: "computer procedures will refuse until the supervisor connection is configured",
  });
}

const server = createApiServer({
  logger,
  limits,
  services: {
    deployment: createDeploymentStatusService(() => readDeploymentSettings(database.database)),
    realtime: new InProcessRealtimeFanout(),
    storage: new LocalStorageProvider({ root: storageRoot }),
    ...(computers === undefined ? {} : { computers }),
    mcp: createMcpService({
      provider: createHttpMcpServerProvider(),
      ingress: createIngressStore(database.database),
      callbackUrl: mcpCallbackUrl,
      database: database.database,
      repositoriesFor: (actor) =>
        createRepositories(actor, queryable(database), { credentialKeys }),
    }),
  },
  // The verified ingress: secrets from the environment through the generic
  // credential store, delivery dedupe through the database. No source is
  // registered yet — the connection slices that own them add a handler and a
  // `PORKBOT_WEBHOOK_SECRET_<SOURCE>` secret, and the route answers 401 until
  // then.
  webhooks: createWebhookIngress({
    secrets: createEnvironmentCredentialStore(process.env),
    deliveries: createIngressStore(database.database),
    handlers: new Map<string, WebhookHandler>(),
    logger,
  }),
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

/**
 * Parses the optional keyring once at boot. Unset keys are not a boot failure
 * — only the secret-bearing procedures depend on them — but they are worth a
 * warning line, and a malformed value is worth saying out loud rather than
 * silently locking every credential.
 */
function readCredentialKeys(): CredentialKeyring | undefined {
  try {
    return credentialKeyringFromEnvironment(process.env);
  } catch (error) {
    logger.warn("PORKBOT_CREDENTIAL_KEYS is not usable; encrypted credentials are locked", {
      error,
    });

    return undefined;
  }
}
