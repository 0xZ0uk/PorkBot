import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CommandError,
  publishedPort,
  registerContainerCleanup,
  removeContainer,
  requireDocker,
  runCommand,
  testkitContainerLabel,
} from "../harness/docker.ts";
import { caddyImage } from "../harness/images.ts";
import { findRepoRoot } from "../paths.ts";

/**
 * The reverse proxy, booted the way the deployment runs it (slice 12.2).
 *
 * The integration suite runs `deploy/Caddyfile` itself — the file the
 * deployment mounts — against the real image the register pins, so a config
 * edit that breaks streaming or the one-origin routing fails a test instead of
 * an operator's browser. The API upstream is a host-local server reached
 * through `host.docker.internal`, which keeps the suite's app stubs on the
 * host rather than in more containers; the SPA is a directory bind-mounted
 * over the path the proxy image bakes the built client into, so the file
 * server and its rewrite are exercised exactly as production runs them.
 *
 * Readiness is the deployment's own healthcheck: the container runs the same
 * loopback probe `deploy/compose.yaml` declares, and this module waits on
 * Docker's health state rather than dialing the proxy itself.
 *
 * The container is owned by the test process: it is registered with the
 * harness's cleanup seam and removed by `stop()`, and a failure to come up
 * removes it before throwing.
 */

/** The loopback port the shipped Caddyfile's health listener binds inside the container. */
export const caddyProbePort = 8899;

/**
 * Where the proxy image bakes `apps/web/dist/client` and where the shipped
 * Caddyfile roots its file server. A test mounts its fixture here, so the
 * directory it serves is the directory the image ships.
 */
export const spaRootPath = "/srv/client";

export interface CaddyProxyOptions {
  /** The Caddy site address: an absolute origin, e.g. `https://localhost`. */
  readonly siteAddress: string;
  /** Where the API mounts point, reachable from inside the container. */
  readonly apiUpstream: string;
  /** The SPA directory to mount at {@link spaRootPath}. */
  readonly webRoot: string;
  /** Defaults to `<repoRoot>/deploy/Caddyfile`, the shipped config. */
  readonly configFile?: string;
  readonly repoRoot?: string;
  readonly readyTimeoutMs?: number;
}

export interface RunningCaddyProxy {
  readonly containerId: string;
  /** The origin a client uses: the site address with the published port. */
  readonly siteUrl: string;
  /** The CA to verify the site against; undefined for an http origin. */
  readonly rootCertificate: string | undefined;
  /** Removes the container (idempotent). */
  stop(): Promise<void>;
}

/** The shipped config's path in a checkout. */
export function proxyConfigPath(repoRoot: string): string {
  return path.join(repoRoot, "deploy", "Caddyfile");
}

/**
 * The host address a container reaches the host on: the bridge network's
 * gateway. An upstream server in a test binds this address, so it is reachable
 * from the proxy without being exposed on every interface.
 */
export async function hostGatewayAddress(): Promise<string> {
  const args = ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"];
  const { stdout } = await runCommand("docker", args);
  const gateway = stdout.trim();

  if (gateway === "") {
    throw new CommandError("docker", args, "the bridge network has no gateway address.");
  }

  return gateway;
}

async function readRootCertificate(containerId: string): Promise<string | undefined> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["exec", containerId, "cat", "/data/caddy/pki/authorities/local/root.crt"],
      { timeoutMs: 10_000 },
    );

    return stdout.includes("BEGIN CERTIFICATE") ? stdout : undefined;
  } catch {
    return undefined;
  }
}

async function healthStatus(containerId: string): Promise<string> {
  const { stdout } = await runCommand(
    "docker",
    ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{end}}", containerId],
    { timeoutMs: 10_000 },
  );

  return stdout.trim();
}

async function waitForProxy(containerId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if ((await healthStatus(containerId)) === "healthy") {
      return;
    }

    if (Date.now() >= deadline) {
      const { stdout } = await runCommand("docker", ["logs", "--tail", "40", containerId], {
        timeoutMs: 10_000,
      }).catch(() => ({ stdout: "" }));

      await removeContainer(containerId).catch(() => {});

      throw new Error(
        `the Caddy proxy did not become healthy within ${timeoutMs} ms. Its log tail was:\n` +
          stdout.trim(),
      );
    }

    await delay(200);
  }
}

/**
 * Starts the proxy with the shipped config and waits until its health probe
 * answers. `stop()` is the deterministic teardown; a process that dies first
 * is covered by the harness cleanup registration.
 */
export async function startCaddyProxy(options: CaddyProxyOptions): Promise<RunningCaddyProxy> {
  await requireDocker();

  const repoRoot = options.repoRoot ?? findRepoRoot();
  const configFile = options.configFile ?? proxyConfigPath(repoRoot);
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const site = new URL(options.siteAddress);
  const containerSitePort =
    site.protocol === "https:" ? 443 : Number(site.port === "" ? "80" : site.port);
  const name = `porkbot-testkit-caddy-${randomBytes(4).toString("hex")}`;
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    testkitContainerLabel,
    // On Linux the host is not `host.docker.internal` by default; this maps it
    // to the bridge gateway. Docker Desktop already resolves it, and an
    // explicit mapping is harmless there.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    `127.0.0.1::${String(containerSitePort)}`,
    // The deployment's own probe, so the container is ready exactly when the
    // config loaded and the API route in it works.
    "--health-cmd",
    `curl --fail --silent --show-error http://127.0.0.1:${String(caddyProbePort)}/healthz`,
    "--health-interval",
    "1s",
    "--health-timeout",
    "2s",
    "--health-retries",
    "60",
    "--env",
    `PORKBOT_SITE_ADDRESS=${options.siteAddress}`,
    "--env",
    `PORKBOT_API_UPSTREAM=${options.apiUpstream}`,
    "--mount",
    `type=bind,source=${configFile},target=/etc/caddy/Caddyfile,readonly`,
    "--mount",
    `type=bind,source=${options.webRoot},target=${spaRootPath},readonly`,
    caddyImage,
  ];
  const { stdout } = await runCommand("docker", args, { timeoutMs: 180_000 });
  const containerId = stdout.trim();

  if (containerId === "") {
    throw new CommandError("docker", args, "docker run returned no container id.");
  }

  registerContainerCleanup(containerId);

  try {
    const { port: sitePort } = await publishedPort(containerId, containerSitePort);

    await waitForProxy(containerId, readyTimeoutMs);

    const rootCertificate =
      site.protocol === "https:" ? await readRootCertificate(containerId) : undefined;

    if (site.protocol === "https:" && rootCertificate === undefined) {
      throw new Error("the https proxy did not publish an internal-CA root certificate.");
    }

    return {
      containerId,
      siteUrl: `${site.protocol}//${site.hostname}:${String(sitePort)}`,
      rootCertificate,
      stop: async (): Promise<void> => {
        await removeContainer(containerId);
      },
    };
  } catch (error) {
    await removeContainer(containerId).catch(() => {});
    throw error;
  }
}
