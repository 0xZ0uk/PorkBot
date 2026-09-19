import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createLogger } from "@porkbot/logging";
import type { ComputerRef } from "@porkbot/adapter-kit";
import { createCredentialProxyServer } from "./credential-proxy.ts";
import type { CredentialProxyServer } from "./credential-proxy.ts";

/**
 * The credential proxy's sidecar entrypoint (slice 7.8, PRD decision 29).
 *
 * A computer's proxy is one process per computer, started by the Docker
 * provider on the machine's own isolated network. This module is what the
 * container runs: it reads the deployment's configuration from the sidecar's
 * environment, starts the proxy server, and answers readiness, so the
 * provider's `ready` check means "the proxy is up and holding grants" rather
 * than only "the container is running".
 *
 * The environment is the sidecar's own: the capability key it verifies run
 * tokens with, the computer it serves, and the grant directory the Docker
 * socket holder writes through the daemon's archive API. None of it is a
 * credential — the grants themselves arrive as files — and none of it is
 * logged. A sidecar configured without a key refuses to start, because a proxy
 * that cannot verify a capability must not serve one.
 */

const logger = createLogger({ service: "@porkbot/adapters/proxy" });

/** The settings a sidecar reads; empty strings are unset, as the deployment means them. */
export function proxySettingsFromEnvironment(env: Readonly<Record<string, string | undefined>>): {
  readonly tokenSecret: string;
  readonly computer: ComputerRef;
  readonly grantDir: string;
  readonly host: string;
  readonly port: number;
} {
  function required(name: string): string {
    const value = env[name]?.trim();

    if (value === undefined || value === "") {
      throw new Error(`the credential proxy needs ${name} to serve a run's grants`);
    }

    return value;
  }

  const portValue = env["PORKBOT_PROXY_PORT"]?.trim() ?? "";

  if (portValue !== "" && !/^\d+$/.test(portValue)) {
    throw new RangeError("PORKBOT_PROXY_PORT must be a whole TCP port number");
  }

  const port = portValue === "" ? 8321 : Number(portValue);

  if (port <= 0 || port > 65_535) {
    throw new RangeError("PORKBOT_PROXY_PORT must be between 1 and 65535");
  }

  return {
    tokenSecret: required("PORKBOT_PROXY_TOKEN_SECRET"),
    computer: {
      computerId: required("PORKBOT_PROXY_COMPUTER_ID"),
      botId: required("PORKBOT_PROXY_BOT_ID"),
    },
    grantDir: required("PORKBOT_PROXY_GRANT_DIR"),
    host: env["PORKBOT_PROXY_HOST"]?.trim() || "0.0.0.0",
    port,
  };
}

/**
 * Starts the sidecar's server from configuration. Exported so the deployment
 * test can drive the entrypoint's real path — settings in, listening server
 * out — without spawning a process.
 */
export async function startProxySidecar(
  env: Readonly<Record<string, string | undefined>>,
): Promise<CredentialProxyServer> {
  const settings = proxySettingsFromEnvironment(env);

  return await createCredentialProxyServer({
    tokenSecret: settings.tokenSecret,
    computer: settings.computer,
    grantDir: settings.grantDir,
    host: settings.host,
    port: settings.port,
  });
}

/**
 * True when this module is the process's entrypoint. Both sides are realpath'd
 * because a deployed workspace links the package into `node_modules`, and the
 * link's path is what `process.argv[1]` carries while `import.meta.url` is the
 * real file — without this, the sidecar would exit zero having done nothing.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];

  if (entry === undefined) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return fileURLToPath(import.meta.url) === entry;
  }
}

if (isEntrypoint()) {
  let server: CredentialProxyServer;

  try {
    server = await startProxySidecar(process.env);
  } catch (error) {
    logger.error("the credential proxy refused to start", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    process.exit(1);
  }

  logger.info("credential proxy listening", { port: server.port });

  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info("credential proxy stopping", { signal });

    void server.close().finally(() => process.exit(0));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
