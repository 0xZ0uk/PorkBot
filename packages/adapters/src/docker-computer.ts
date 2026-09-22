import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertComputerNetworkPlan, planComputerNetwork } from "@porkbot/core";
import type { ComputerNetworkPlan } from "@porkbot/core";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerProxyEndpoint,
  ComputerProxyGrant,
  ComputerRef,
  ComputerState,
  CredentialProxyAdmin,
  StorageProvider,
} from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";
import {
  createComputerSnapshotStore,
  DEFAULT_COMPUTER_ARCHIVE_DIRECTORY,
} from "./computer-snapshot-store.ts";
import { proxyGrantFileName, serializeProxyGrant } from "./credential-proxy.ts";
import { writeTar } from "./computer-archive.ts";
import { createDockerEngine } from "./docker-engine.ts";
import type { DockerContainerInspect, DockerEngine, DockerLogConfig } from "./docker-engine.ts";
import { classifyDockerFailure, DockerProtocolError } from "./docker-errors.ts";
import { computerIdentityHash, createRuntimeComputerProvider } from "./computer-runtime.ts";
import type {
  ComputerListedMachine,
  ComputerMachine,
  ComputerRuntime,
} from "./computer-runtime.ts";

/**
 * The Docker computer provider (slice 7.2, PRD decisions 19, 20 and 32; stories
 * 27, 29).
 *
 * A bot's computer on a real daemon: one container on a per-computer internal
 * network, its home on a named volume, its CPU, memory and process count
 * bounded, and a boot that is bounded and reported. The provider is
 * constructed inside the supervisor process only — the same process that holds
 * the Docker socket (slice 7.1) — and reaches the daemon through the Engine
 * API in `docker-engine.ts`. No other process imports it.
 *
 * This file is the Docker runtime: the primitives only Docker can answer.
 * `computer-runtime.ts` owns the lifecycle composition those primitives feed —
 * idempotent boot and stop, bounded readiness, `gone` answers, scoped
 * snapshots — so the cloud provider (slice 7.3) shares it rather than copying
 * it, and the two providers cannot drift on what `ensure` or `destroy` means.
 *
 * What survives what is the contract this file exists to keep:
 *
 *   - `stop` parks the container; the home volume is untouched, so an idle
 *     machine is shut down without losing the agent home;
 *   - `remove` removes the container and keeps the named home volume, so the
 *     supervisor's reset (destroy, then ensure) rebuilds a clean machine with
 *     the bot's files intact;
 *   - `readHome` streams the home out through the daemon's archive API into a
 *     staging file, and `writeHome` streams an archive back in, so a snapshot
 *     outlives the container it came from. The shared lifecycle hands those
 *     staging files to the snapshot store, which writes them through the
 *     storage seam and verifies them before a restore replaces a machine
 *     (slice 7.5); this file never names a storage key.
 *
 * Failure mapping: every daemon error goes through `classifyDockerFailure`
 * (slice 7.2, PRD decision 19), so `ensure` on a missing container is `gone`,
 * a missing image is `not_found`, a registry quota is `rate_limited`, an
 * unanswered call is `timed_out` and a refused credential is `auth_failed`.
 * This file names no Docker status and no Docker message: that is
 * `docker-errors.ts`' one job, checked by
 * `docker-failure.call-sites.test.ts`.
 *
 * Isolation: the runtime computes the network plan from the computer's
 * identity with `planComputerNetwork` and asserts it before anything is
 * created, then creates the network with the plan's `internal` and
 * `gateway_mode_ipv4=isolated` properties and attaches the container to it —
 * never to the default bridge, the host network or a published port. The
 * isolation check itself lives in the supervisor's lifecycle for every
 * provider; this runtime creates the plan it is given.
 *
 * Ceilings: CPU (fractional cores), memory (with swap pinned to the same
 * size), the process count and an optional write-layer disk quota come from
 * the provider's configuration, per bot. The defaults are one bot's share of
 * the PRD's host floor — 4 vCPU / 8 GB plus about 2 GB per bot — and the
 * README states the floor beside them.
 */

/** The resource slice one computer runs inside; per-bot overridable. */
export interface ComputerCeilings {
  /** Whole or fractional CPU cores, for example `1` or `0.5`. */
  readonly cpus: number;
  /** Memory in mebibytes; swap is pinned to the same ceiling. */
  readonly memoryMb: number;
  /** The write-layer quota in mebibytes; applied only with `diskQuota`. */
  readonly diskMb: number;
  /** The most processes (threads included) the container may create. */
  readonly pids: number;
  /** The size of `/tmp`, in mebibytes. */
  readonly tmpfsMb: number;
  /** The daemon's `json-file` rotation policy for the container's log. */
  readonly logConfig: DockerLogConfig;
}

/**
 * The log rotation policy the stack gives its own compose services
 * (`deploy/compose.yaml`, the `x-app` anchor): ten mebibytes per file, three
 * files, so a chatty machine costs at most about thirty mebibytes of the
 * host's disk instead of growing without bound. Named so an operator can
 * raise it deliberately rather than edit a create body.
 */
export const DEFAULT_COMPUTER_LOG_CONFIG: DockerLogConfig = {
  maxSize: "10m",
  maxFile: "3",
};

/**
 * One bot's share of the PRD's documented host floor: a host runs 4 vCPU and
 * 8 GB with roughly 2 GB per bot, so the default bot gets half a host's CPU
 * and a quarter of its memory, and the deployment must size itself against the
 * floor rather than assume a bot is free. Disk is documented rather than
 * enforced by default because Docker enforces a write-layer quota only on a
 * storage driver that answers it (`overlay2` over xfs with `pquota`, or
 * `btrfs`); see `diskQuota`.
 */
export const DEFAULT_COMPUTER_CEILINGS: ComputerCeilings = {
  cpus: 1,
  memoryMb: 2048,
  diskMb: 10_240,
  pids: 512,
  tmpfsMb: 256,
  logConfig: DEFAULT_COMPUTER_LOG_CONFIG,
};

/** The home directory a computer starts in, unless configured otherwise. */
export const DEFAULT_DOCKER_COMPUTER_HOME = "/home/agent";

/** The labels every managed container carries, so `list` finds exactly ours. */
export const dockerComputerLabels = {
  managed: "porkbot.managed",
  computerId: "porkbot.computer.id",
  botId: "porkbot.bot.id",
} as const;

/**
 * The label a proxy sidecar carries instead of `computer.id` (slice 7.8). It
 * names the computer it serves, but under a different key so `list` never
 * reports a sidecar as a second machine.
 */
export const dockerProxyLabel = "porkbot.proxy.for";

/**
 * The directory grant files land in inside a proxy container. It is the
 * sidecar's own filesystem, never a mount shared with a sandbox: the daemon's
 * archive API is the only writer, and the sandbox has no mount of it. (A tmpfs
 * here would be shadowed at runtime — an archive write lands in the layer, not
 * the mount — so the sidecar's layer is the honest place for them.) Grants are
 * written relative to the container's root, where a `grants/...` entry makes
 * the directory as it is extracted; the daemon refuses an archive whose
 * destination path does not exist yet.
 */
export const DOCKER_PROXY_GRANT_DIR = "/grants";
/** The archive destination a grant is written under: the root, with a `grants/` entry. */
export const DOCKER_PROXY_ARCHIVE_PATH = "/";

/** The port the proxy listens on inside its container. */
export const DEFAULT_DOCKER_PROXY_PORT = 8321;

/**
 * The credential-proxy sidecar's settings (slice 7.8, PRD decision 29).
 *
 * The sidecar is one extra container per computer, created on the computer's
 * own isolated network — the only network peer a sandbox can reach — and
 * secondarily attached to the deployment's egress network, which is the leg
 * that reaches an upstream. The grants it holds are tmpfs, written through
 * the daemon's archive API, so the Docker socket holder is the only writer
 * and no credential ever crosses a bind mount or a shared filesystem.
 */
export interface DockerProxyOptions {
  /** The image the sidecar runs: the deployed workspace, which carries the proxy entrypoint. */
  readonly image: string;
  /** The HMAC key the proxy verifies run capabilities with; shared with the worker. */
  readonly tokenSecret: string;
  /** The deployment's egress network the sidecar joins for the upstream leg. */
  readonly egressNetwork: string;
  /** The container's command; the default is the adapter's own proxy entrypoint. */
  readonly command?: readonly string[] | undefined;
  /** The port the proxy binds; 8321 by default. */
  readonly port?: number | undefined;
}

export interface DockerComputerProviderOptions {
  /** The image a computer boots from; the deployment's one image contract. */
  readonly image: string;
  /** The daemon's unix socket; `/var/run/docker.sock` by default. */
  readonly socketPath?: string | undefined;
  /** A TCP endpoint; used instead of the socket when given (tests, remote hosts). */
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  /** The agent's home directory inside the container. */
  readonly home?: string | undefined;
  /** The container user; the image's own default when unset. */
  readonly user?: string | undefined;
  /** How long `ensure` waits for a machine to become ready, in milliseconds. */
  readonly bootTimeoutMs?: number | undefined;
  /** The budget for one lifecycle call, in milliseconds. */
  readonly requestTimeoutMs?: number | undefined;
  /** How long a snapshot or restore archive may take, in milliseconds. */
  readonly archiveTimeoutMs?: number | undefined;
  /**
   * `missing` pulls the image only when the daemon does not have it (the
   * default), `always` pulls on every boot and `never` refuses to reach a
   * registry at all.
   */
  readonly pullPolicy?: "missing" | "always" | "never" | undefined;
  /** Defaults merged with per-bot overrides; a function gets the full reference. */
  readonly ceilings?:
    Partial<ComputerCeilings> | ((computer: ComputerRef) => Partial<ComputerCeilings>) | undefined;
  /**
   * `storage-opt` sends a write-layer quota with every create; the daemon
   * refuses the create on a driver without quota support, which is the
   * fail-closed answer. `none` (the default) leaves the disk ceiling to the
   * host floor the README documents.
   */
  readonly diskQuota?: "storage-opt" | "none" | undefined;
  /**
   * The storage seam every snapshot archive is written through (slice 7.5).
   * Required: a provider with nowhere durable to put an archive would answer
   * `snapshot` with bytes it cannot keep, which is worse than saying so.
   */
  readonly storage: StorageProvider;
  /** Where an archive is staged while it is written or verified. */
  readonly scratchDirectory?: string | undefined;
  /** The most stdout or stderr one command may return, in bytes. */
  readonly maxOutputBytes?: number | undefined;
  /**
   * The credential-proxy sidecar (slice 7.8). Configured means every computer
   * gets one and the provider exposes `proxy`; absent means no sidecar and no
   * proxy seam, which is the honest answer for a deployment that has no
   * egress network or capability key to run one with.
   */
  readonly proxy?: DockerProxyOptions | undefined;
  /** Injected for tests; built from the endpoint options when absent. */
  readonly engine?: DockerEngine | undefined;
}

function containerName(computer: ComputerRef): string {
  return `porkbot-computer-${computerIdentityHash(`${computer.botId}\u0000${computer.computerId}`)}`;
}

function volumeName(computer: ComputerRef): string {
  return `porkbot-home-${computerIdentityHash(`${computer.botId}\u0000${computer.computerId}`)}`;
}

function proxyName(computer: ComputerRef): string {
  return `porkbot-proxy-${computerIdentityHash(`${computer.botId}\u0000${computer.computerId}`)}`;
}

/**
 * The names a computer's containers carry, derived from one identity hash.
 * Exported so a test can address the machine and its sidecar, whose references
 * the provider keeps private.
 */
export function dockerProxyName(computer: ComputerRef): string {
  return proxyName(computer);
}

export function dockerComputerName(computer: ComputerRef): string {
  return containerName(computer);
}

function assertCeilings(ceilings: ComputerCeilings): void {
  const positiveIntegers: readonly (readonly [string, number])[] = [
    ["memoryMb", ceilings.memoryMb],
    ["diskMb", ceilings.diskMb],
    ["pids", ceilings.pids],
    ["tmpfsMb", ceilings.tmpfsMb],
  ];

  if (!Number.isFinite(ceilings.cpus) || ceilings.cpus <= 0) {
    throw new RangeError(
      `computer ceiling cpus must be a positive number, received ${ceilings.cpus}`,
    );
  }

  for (const [name, value] of positiveIntegers) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(
        `computer ceiling ${name} must be a positive integer, received ${value}`,
      );
    }
  }

  // Docker's `max-size` is a positive integer with an optional `b`, `k`, `m`,
  // `g`, `t` or `p` suffix; `max-file` is a positive integer string.
  if (!/^\d+[bkmgtp]?$/i.test(ceilings.logConfig.maxSize)) {
    throw new RangeError(
      `computer ceiling logConfig.maxSize must be a Docker max-size, received "${ceilings.logConfig.maxSize}"`,
    );
  }

  if (!/^[1-9]\d*$/.test(ceilings.logConfig.maxFile)) {
    throw new RangeError(
      `computer ceiling logConfig.maxFile must be a positive integer string, received "${ceilings.logConfig.maxFile}"`,
    );
  }
}

/** Maps the daemon's container record onto the seam's two live states. */
function stateOf(inspect: DockerContainerInspect): ComputerState {
  return inspect.State?.Running === true ? "running" : "stopped";
}

function machineOf(inspect: DockerContainerInspect): ComputerMachine {
  return { instanceId: inspect.Id, state: stateOf(inspect) === "running" ? "running" : "stopped" };
}

function refFromLabels(
  labels: Readonly<Record<string, string>> | undefined,
): ComputerRef | undefined {
  const computerId = labels?.[dockerComputerLabels.computerId];
  const botId = labels?.[dockerComputerLabels.botId];

  if (typeof computerId !== "string" || computerId.trim() === "") {
    return undefined;
  }

  if (typeof botId !== "string" || botId.trim() === "") {
    return undefined;
  }

  return { computerId, botId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The sidecar's own slice: small, because a proxy is a loop, not a workload.
 * Its writable layer holds the grant files — the only place they can live
 * while the daemon's archive API is the writer — and a grant is kilobytes, so
 * the whole layer stays far inside this bound. The log rotation policy is the
 * machine's default: a sidecar is a container on the host's disk too.
 */
const PROXY_SIDECAR_RESOURCES = {
  nanoCpus: 250_000_000,
  memoryBytes: 128 * 1024 * 1024,
  pidsLimit: 128,
  logConfig: DEFAULT_COMPUTER_LOG_CONFIG,
} as const;

/** Builds the runtime over one daemon; `createDockerComputerProvider` owns the seam. */
function createDockerRuntime(options: DockerComputerProviderOptions): {
  readonly runtime: ComputerRuntime;
  readonly proxy: CredentialProxyAdmin | undefined;
} {
  if (options.image.trim() === "") {
    throw new RangeError("the Docker computer provider needs an image");
  }

  const home = options.home ?? DEFAULT_DOCKER_COMPUTER_HOME;

  if (!home.startsWith("/") || home === "/") {
    throw new RangeError(`home must be an absolute path below the root, received "${home}"`);
  }

  const bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const archiveTimeoutMs = options.archiveTimeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 262_144;
  const pullPolicy = options.pullPolicy ?? "missing";
  const defaults = {
    ...DEFAULT_COMPUTER_CEILINGS,
    ...(typeof options.ceilings === "function" ? {} : (options.ceilings ?? {})),
  };
  assertCeilings(defaults);

  const engine =
    options.engine ??
    createDockerEngine({
      socketPath:
        options.socketPath ?? (options.host === undefined ? "/var/run/docker.sock" : undefined),
      host: options.host,
      port: options.port,
      requestTimeoutMs,
    });

  function ceilingsFor(computer: ComputerRef): ComputerCeilings {
    const overrides = typeof options.ceilings === "function" ? options.ceilings(computer) : {};
    const merged = { ...defaults, ...overrides };

    // An empty object spread must not be able to produce `undefined` values.
    assertCeilings(merged);
    return merged;
  }

  function planFor(computer: ComputerRef): ComputerNetworkPlan {
    return assertComputerNetworkPlan(planComputerNetwork(computer));
  }

  function failure(error: unknown, subject: Parameters<typeof classifyDockerFailure>[1]): never {
    throw classifyDockerFailure(error, subject);
  }

  /** Runs one daemon call, translating a refusal before it can escape the adapter. */
  async function guarded<T>(
    call: Promise<T>,
    subject: Parameters<typeof classifyDockerFailure>[1],
  ): Promise<T> {
    return await call.catch((error: unknown) => failure(error, subject));
  }

  const proxyOptions = options.proxy;
  const proxyPort = proxyOptions?.port ?? DEFAULT_DOCKER_PROXY_PORT;

  function proxyEndpointFor(computer: ComputerRef): ComputerProxyEndpoint {
    // The sandbox resolves the sidecar by its container name over the shared
    // isolated network's Docker DNS; no published port, no host address.
    return { url: `http://${proxyName(computer)}:${proxyPort}` };
  }

  function proxySpec(
    computer: ComputerRef,
    network: string,
  ): Parameters<DockerEngine["createContainer"]>[0] {
    if (proxyOptions === undefined) {
      throw new Error("a proxy sidecar was requested with no proxy configured");
    }

    return {
      name: proxyName(computer),
      image: proxyOptions.image,
      labels: {
        [dockerComputerLabels.managed]: "true",
        [dockerProxyLabel]: computer.computerId,
        [dockerComputerLabels.botId]: computer.botId,
      },
      network,
      workingDirectory: "/",
      user: "node",
      command: proxyOptions.command ?? [
        "node",
        "/app/node_modules/@porkbot/adapters/dist/proxy-main.js",
      ],
      // The capability key is the sidecar's whole trust basis: the deployment
      // configures it on this container and on the worker, and no sandbox ever
      // sees it. Grants live on this container's own layer — no bind, no shared
      // volume — so a stop or a destroy takes the credential material with it.
      environment: {
        PORKBOT_PROXY_TOKEN_SECRET: proxyOptions.tokenSecret,
        PORKBOT_PROXY_COMPUTER_ID: computer.computerId,
        PORKBOT_PROXY_BOT_ID: computer.botId,
        PORKBOT_PROXY_GRANT_DIR: DOCKER_PROXY_GRANT_DIR,
        PORKBOT_PROXY_PORT: String(proxyPort),
        PORKBOT_PROXY_HOST: "0.0.0.0",
      },
      // The probe is what makes the provider's `ready` mean "the proxy is
      // listening": a running process that has not bound its port yet would
      // otherwise accept a grant the proxy could never read. A TCP connect is
      // the whole readiness question here — the server binds before it serves
      // — and `node` is the image's own binary, so the probe needs nothing
      // installed.
      healthcheck: {
        test: [
          "CMD",
          "node",
          "-e",
          `const net=require("node:net");const socket=net.connect(${String(proxyPort)},"127.0.0.1",()=>{socket.end();process.exit(0)});socket.on("error",()=>process.exit(1))`,
        ],
        intervalMs: 500,
        timeoutMs: 2_000,
        retries: 20,
        startPeriodMs: 1_000,
      },
      resources: PROXY_SIDECAR_RESOURCES,
    };
  }

  async function inspectProxy(computer: ComputerRef): Promise<DockerContainerInspect | undefined> {
    return await guarded(
      engine.inspectContainer(proxyName(computer), requestTimeoutMs),
      "container",
    );
  }

  /**
   * Waits for the sidecar's own readiness, not merely its existence: the
   * sidecar declares a healthcheck that fetches its `/healthz`, so a grant is
   * only ever written once the proxy answers. A sidecar that is running but
   * not yet listening would otherwise accept a grant it could not read.
   */
  async function waitProxyReady(computer: ComputerRef, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;

    for (;;) {
      const proxy = await inspectProxy(computer);

      if (proxy?.State?.Running !== true) {
        throw new ComputerProviderError(
          "gone",
          "the machine's credential proxy has stopped; re-read its state",
        );
      }

      const health = proxy.State?.Health?.Status;

      if (health === undefined || health === "healthy") {
        return;
      }

      if (health === "unhealthy") {
        throw new ComputerProviderError(
          "gone",
          "the machine's credential proxy reported unhealthy; re-read its state",
        );
      }

      if (Date.now() >= deadline) {
        throw new ComputerProviderError(
          "timed_out",
          `the machine's credential proxy did not become ready within ${budgetMs}ms`,
        );
      }

      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  async function createProxyFor(computer: ComputerRef, network: string): Promise<string> {
    if (proxyOptions === undefined) {
      throw new Error("a proxy sidecar was requested with no proxy configured");
    }

    let id: string;

    try {
      id = await engine.createContainer(proxySpec(computer, network), requestTimeoutMs);
    } catch (error) {
      const adopted = await engine
        .inspectContainer(proxyName(computer), requestTimeoutMs)
        .catch(() => undefined);

      if (adopted !== undefined) {
        id = adopted.Id;
      } else {
        failure(error, "container");
      }
    }

    // The upstream leg: the sidecar's second interface is the deployment's
    // egress network. Its first — the one the create attached — is the
    // computer's own isolated network, which is what makes this container the
    // only network peer a sandbox can reach.
    await guarded(
      engine.connectNetwork(id, proxyOptions.egressNetwork, undefined, requestTimeoutMs),
      "network",
    );

    return id;
  }

  async function ensureImage(image: string, budgetMs: number): Promise<void> {
    const present = await guarded(engine.imageExists(image, budgetMs), "image");

    if (present && pullPolicy !== "always") {
      return;
    }

    if (pullPolicy === "never") {
      throw new ComputerProviderError(
        "not_found",
        `the image "${image}" is not present and pulling is disabled`,
      );
    }

    await guarded(engine.pullImage(image, archiveTimeoutMs), "image");
  }

  async function waitReady(id: string, budgetMs: number): Promise<ComputerMachine> {
    const deadline = Date.now() + budgetMs;

    for (;;) {
      const inspect = await guarded(engine.inspectContainer(id, requestTimeoutMs), "container");

      if (inspect === undefined) {
        throw new ComputerProviderError(
          "gone",
          "the machine disappeared while booting; re-read its state",
        );
      }

      const health = inspect.State?.Health?.Status;

      if (inspect.State?.Running === true && (health === undefined || health === "healthy")) {
        return machineOf(inspect);
      }

      if (health === "unhealthy") {
        throw new DockerProtocolError(`the machine reported unhealthy while booting (${id})`);
      }

      if (Date.now() >= deadline) {
        throw new ComputerProviderError(
          "timed_out",
          `the machine did not become ready within ${budgetMs}ms; re-read its state before reuse`,
        );
      }

      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  function createSpec(
    computer: ComputerRef,
    network: string,
  ): Parameters<DockerEngine["createContainer"]>[0] {
    const ceilings = ceilingsFor(computer);

    return {
      name: containerName(computer),
      image: options.image,
      labels: {
        [dockerComputerLabels.managed]: "true",
        [dockerComputerLabels.computerId]: computer.computerId,
        [dockerComputerLabels.botId]: computer.botId,
      },
      network,
      workingDirectory: home,
      homeVolume: volumeName(computer),
      user: options.user,
      resources: {
        nanoCpus: Math.round(ceilings.cpus * 1_000_000_000),
        memoryBytes: ceilings.memoryMb * 1024 * 1024,
        pidsLimit: ceilings.pids,
        tmpfsBytes: ceilings.tmpfsMb * 1024 * 1024,
        storageSize:
          options.diskQuota === "storage-opt" ? `${String(ceilings.diskMb)}M` : undefined,
        logConfig: ceilings.logConfig,
      },
    };
  }

  async function createFor(computer: ComputerRef, network: string): Promise<string> {
    try {
      return await engine.createContainer(createSpec(computer, network), requestTimeoutMs);
    } catch (error) {
      // Two ensures can race on a cold boot. Instead of reading the daemon's
      // conflict status, this re-reads the name: a container that appeared is
      // adopted as the idempotent answer, and anything else is classified.
      const adopted = await engine
        .inspectContainer(containerName(computer), requestTimeoutMs)
        .catch(() => undefined);

      if (adopted !== undefined) {
        return adopted.Id;
      }

      failure(error, "container");
    }
  }

  async function inspectFor(computer: ComputerRef): Promise<DockerContainerInspect | undefined> {
    return await guarded(
      engine.inspectContainer(containerName(computer), requestTimeoutMs),
      "container",
    );
  }

  const runtime: ComputerRuntime = {
    async validate(): Promise<void> {
      // The daemon's own ping: the socket answers only when the daemon is
      // there, and the check is read-only, so a selection cannot leave a
      // container, a network or an image behind. The subject is the daemon, so
      // a refused call is classified for what it is rather than as a missing
      // machine.
      await guarded(engine.ping(), "daemon");
    },

    async find(computer: ComputerRef): Promise<ComputerMachine | undefined> {
      const inspect = await inspectFor(computer);

      return inspect === undefined ? undefined : machineOf(inspect);
    },

    async list(): Promise<readonly ComputerListedMachine[]> {
      const summaries = await guarded(
        engine.listContainers({ [dockerComputerLabels.managed]: "true" }, requestTimeoutMs),
        "container",
      );
      const listed: ComputerListedMachine[] = [];

      for (const summary of summaries) {
        const computer = refFromLabels(summary.Labels);

        if (computer === undefined) {
          continue;
        }

        listed.push({
          computer,
          machine: {
            instanceId: summary.Id,
            state: summary.State === "running" ? "running" : "stopped",
          },
        });
      }

      return listed;
    },

    async prepare(computer: ComputerRef): Promise<void> {
      await ensureImage(options.image, requestTimeoutMs);

      if (proxyOptions !== undefined) {
        await ensureImage(proxyOptions.image, requestTimeoutMs);
      }

      await guarded(engine.ensureNetwork(planFor(computer), requestTimeoutMs), "network");
    },

    async create(computer: ComputerRef): Promise<ComputerMachine> {
      const network = planFor(computer);
      const id = await createFor(computer, network.name);

      if (proxyOptions !== undefined) {
        try {
          await createProxyFor(computer, network.name);
        } catch (error) {
          // A half-boot is never left behind: the machine goes back to gone
          // and the next ensure starts clean rather than adopting a computer
          // whose proxy is missing.
          await engine
            .removeContainer(id, { force: true }, requestTimeoutMs)
            .catch(() => undefined);
          throw error;
        }
      }

      return { instanceId: id, state: "stopped" };
    },

    async start(machine: ComputerMachine, computer: ComputerRef): Promise<ComputerMachine> {
      if (proxyOptions !== undefined) {
        // A sidecar left over from a crash is replaced, not adopted: its
        // layer may hold a dead run's grant and its configuration may name an
        // older capability key, and a fresh sidecar is a loop, not a cost.
        // The machine is stopped here — a running machine never reaches this
        // path — so nothing live is lost by the removal.
        const existing = await inspectProxy(computer);

        if (existing !== undefined) {
          await engine
            .removeContainer(existing.Id, { force: true }, requestTimeoutMs)
            .catch((error: unknown) => failure(error, "container"));
        }

        const proxyId = await createProxyFor(computer, planFor(computer).name);

        await engine
          .startContainer(proxyId, requestTimeoutMs)
          .catch((error: unknown) => failure(error, "container"));
      }

      await engine
        .startContainer(machine.instanceId, bootTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      return { instanceId: machine.instanceId, state: "running" };
    },

    async stop(
      machine: ComputerMachine,
      computer: ComputerRef,
    ): Promise<ComputerMachine | undefined> {
      await engine
        .stopContainer(machine.instanceId, 10, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      // The sidecar parks with its machine and its grants park with it: a
      // parked computer has no live run, so a grant that outlived its run —
      // the writer crashed before revoking — must not be reachable when the
      // machine comes back. Removing the sidecar is what makes "parked means
      // gone" true on Docker, exactly as the emulator's stop releases its
      // proxy; the next `start` creates a fresh sidecar with an empty layer.
      if (proxyOptions !== undefined) {
        const proxy = await inspectProxy(computer);

        if (proxy !== undefined) {
          await engine
            .removeContainer(proxy.Id, { force: true }, requestTimeoutMs)
            .catch((error: unknown) => failure(error, "container"));
        }
      }

      const stopped = await engine
        .inspectContainer(machine.instanceId, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      return stopped === undefined ? undefined : machineOf(stopped);
    },

    async remove(machine: ComputerMachine, computer: ComputerRef): Promise<void> {
      if (proxyOptions !== undefined) {
        const proxy = await inspectProxy(computer);

        if (proxy !== undefined) {
          await engine
            .removeContainer(proxy.Id, { force: true }, requestTimeoutMs)
            .catch((error: unknown) => failure(error, "container"));
        }
      }

      await engine
        .removeContainer(machine.instanceId, { force: true }, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      // The per-computer network ends with the machine. `stop` parks and keeps
      // it, so a parked computer comes back on the same isolation plan; a
      // destroyed one is over, and the daemon's subnet pools are finite — a
      // destroy that left its network behind eventually refuses the next boot
      // with "all predefined address pools have been fully subnetted". The
      // home volume is deliberately not removed here: it is the durable lane
      // that `stop`/`ensure`, `reset` and the backup snapshots rely on.
      await engine
        .removeNetwork(planFor(computer).name, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "network"));
    },

    async ready(machine: ComputerMachine, computer: ComputerRef, budgetMs: number) {
      const ready = await waitReady(machine.instanceId, budgetMs);

      if (proxyOptions !== undefined) {
        await waitProxyReady(computer, budgetMs);
      }

      return ready;
    },

    async exec(
      machine: ComputerMachine,
      _computer: ComputerRef,
      request: ComputerExecRequest,
    ): Promise<ComputerExecResult> {
      const result = await engine
        .exec({
          containerId: machine.instanceId,
          command: request.command,
          workingDirectory: home,
          environment: request.environment,
          timeoutMs: request.timeoutMs,
          maxOutputBytes,
        })
        .catch((error: unknown) => failure(error, "exec"));

      // The wrapper runs the command under the image's `timeout`, which exits
      // 124 exactly when it fired; the seam calls that timed_out rather than
      // handing the run a killed process as an ordinary result.
      if (result.exitCode === 124) {
        throw new ComputerProviderError(
          "timed_out",
          `the command outran its ${request.timeoutMs}ms budget and was killed`,
        );
      }

      const truncated = result.truncated ? "\n[output truncated]" : "";

      return {
        exitCode: result.exitCode,
        stdout: `${result.stdout}${truncated}`,
        stderr: result.stderr,
      };
    },

    async readHome(machine: ComputerMachine, _computer: ComputerRef, destination: string) {
      const archive = await engine
        .getArchive(machine.instanceId, home, archiveTimeoutMs)
        .catch((error: unknown) => failure(error, "archive"));

      try {
        await pipeline(archive.stream, createWriteStream(destination));
      } catch (error) {
        // A stream that failed mid-copy is a transport fault, and an already
        // classified failure passes through with its kind intact.
        failure(error, "archive");
      }
    },

    async writeHome(
      machine: ComputerMachine,
      _computer: ComputerRef,
      source: string,
      byteLength: number,
    ) {
      const stream = createReadStream(source);

      await engine
        .putArchive(
          machine.instanceId,
          path.dirname(home),
          { stream, length: byteLength },
          archiveTimeoutMs,
        )
        .catch((error: unknown) => failure(error, "archive"));
    },
  };

  // The credential-proxy administration (slice 7.8). Grants and tombstones
  // cross through the daemon's archive API alone, which is what keeps the
  // Docker socket holder the only writer of credential material — the proxy
  // container serves reads; it is never asked to mutate its own grants.
  const proxy: CredentialProxyAdmin | undefined =
    proxyOptions === undefined
      ? undefined
      : {
          async grant(
            computer: ComputerRef,
            grant: ComputerProxyGrant,
          ): Promise<ComputerProxyEndpoint> {
            const proxy = await inspectProxy(computer);

            if (proxy?.State?.Running !== true) {
              throw new ComputerProviderError(
                "gone",
                "the computer's credential proxy has not started; boot the machine first",
              );
            }

            const archive = writeTar([
              {
                name: `grants/${proxyGrantFileName(grant.runId)}`,
                content: serializeProxyGrant(grant),
              },
            ]);

            await engine
              .putArchive(proxy.Id, DOCKER_PROXY_ARCHIVE_PATH, {
                stream: Readable.from(archive),
                length: archive.byteLength,
              })
              .catch((error: unknown) => failure(error, "archive"));

            return proxyEndpointFor(computer);
          },

          async revoke(computer: ComputerRef, runId: string): Promise<void> {
            const proxy = await inspectProxy(computer);

            if (proxy?.State?.Running !== true) {
              // A gone or parked proxy holds nothing — its grants are tmpfs,
              // which dies with the process — so the revoke is already done.
              return;
            }

            // The tombstone is a grant that is already expired: the proxy
            // reads it on every request and answers `no_grant`, so revocation
            // is durable even if a later read races the file.
            const archive = writeTar([
              {
                name: `grants/${proxyGrantFileName(runId)}`,
                content: serializeProxyGrant({
                  runId,
                  expiresAtSeconds: 1,
                  upstreams: [],
                }),
              },
            ]);

            await engine
              .putArchive(proxy.Id, DOCKER_PROXY_ARCHIVE_PATH, {
                stream: Readable.from(archive),
                length: archive.byteLength,
              })
              .catch((error: unknown) => failure(error, "archive"));
          },

          async endpoint(computer: ComputerRef): Promise<ComputerProxyEndpoint | undefined> {
            const proxy = await inspectProxy(computer);

            return proxy?.State?.Running === true ? proxyEndpointFor(computer) : undefined;
          },
        };

  return { runtime, proxy };
}

export function createDockerComputerProvider(
  options: DockerComputerProviderOptions,
): ComputerProvider {
  const { runtime, proxy } = createDockerRuntime(options);

  return {
    ...createRuntimeComputerProvider({
      runtime,
      snapshots: createComputerSnapshotStore({
        storage: options.storage,
        scratchDirectory: options.scratchDirectory ?? DEFAULT_COMPUTER_ARCHIVE_DIRECTORY,
      }),
      bootTimeoutMs: options.bootTimeoutMs,
    }),
    ...(proxy === undefined ? {} : { proxy }),
  };
}
