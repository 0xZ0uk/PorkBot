import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { assertComputerNetworkPlan, planComputerNetwork } from "@porkbot/core";
import type { ComputerNetworkPlan } from "@porkbot/core";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerState,
  ComputerStatus,
} from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";
import { classifyDockerFailure, DockerProtocolError } from "./docker-errors.ts";
import { createDockerEngine } from "./docker-engine.ts";
import type { DockerContainerInspect, DockerEngine } from "./docker-engine.ts";

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
 * What survives what is the contract this file exists to keep:
 *
 *   - `stop` parks the container; the home volume is untouched, so an idle
 *     machine is shut down without losing the agent home;
 *   - `destroy` removes the container and keeps the named home volume, so the
 *     supervisor's reset (destroy, then ensure) rebuilds a clean machine with
 *     the bot's files intact;
 *   - `snapshot` streams the home out through the daemon's archive API into
 *     the provider's snapshot directory, and `restore` replaces the machine
 *     and streams the archive back in, so a snapshot outlives the container it
 *     came from. The storage seam (slice 7.5) is the next owner of the archive
 *     directory; until then it is configuration.
 *
 * Failure mapping: every daemon error goes through `classifyDockerFailure`
 * (slice 7.2, PRD decision 19), so `ensure` on a missing container is `gone`,
 * a missing image is `not_found`, a registry quota is `rate_limited`, an
 * unanswered call is `timed_out` and a refused credential is `auth_failed`.
 * This file names no Docker status and no Docker message: that is
 * `docker-errors.ts`' one job, checked by
 * `docker-failure.call-sites.test.ts`.
 *
 * Isolation: the provider computes the network plan from the computer's
 * identity with `planComputerNetwork` and asserts it before anything is
 * created, then creates the network with the plan's `internal` and
 * `gateway_mode_ipv4=isolated` properties and attaches the container to it —
 * never to the default bridge, the host network or a published port. An
 * existing network under the planned name is adopted only when it still
 * carries the isolation the plan declares.
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
}

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
};

/** The home directory a computer starts in, unless configured otherwise. */
export const DEFAULT_DOCKER_COMPUTER_HOME = "/home/agent";

/** Where snapshots land until the storage seam takes ownership (slice 7.5). */
export const DEFAULT_DOCKER_SNAPSHOT_DIRECTORY = "/var/lib/porkbot/computer-snapshots";

/** The labels every managed container carries, so `list` finds exactly ours. */
export const dockerComputerLabels = {
  managed: "porkbot.managed",
  computerId: "porkbot.computer.id",
  botId: "porkbot.bot.id",
} as const;

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
  /** Where home archives land; the storage seam (slice 7.5) will take this over. */
  readonly snapshotDirectory?: string | undefined;
  /** The most stdout or stderr one command may return, in bytes. */
  readonly maxOutputBytes?: number | undefined;
  /** Injected for tests; built from the endpoint options when absent. */
  readonly engine?: DockerEngine | undefined;
}

/** A snapshot's key as this provider names it: `<scope>/<snapshotId>.tar`. */
const snapshotKeyPattern = /^([0-9a-f]{16})\/([0-9a-f-]{36})\.tar$/;

function identityHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function containerName(computer: ComputerRef): string {
  return `porkbot-computer-${identityHash(`${computer.botId}\u0000${computer.computerId}`)}`;
}

function volumeName(computer: ComputerRef): string {
  return `porkbot-home-${identityHash(`${computer.botId}\u0000${computer.computerId}`)}`;
}

function snapshotScope(computer: ComputerRef): string {
  return identityHash(`snapshot\u0000${computer.botId}\u0000${computer.computerId}`);
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
}

/** Maps the daemon's container record onto the seam's three states. */
function stateOf(inspect: DockerContainerInspect): ComputerState {
  return inspect.State?.Running === true ? "running" : "stopped";
}

function statusOf(computer: ComputerRef, inspect: DockerContainerInspect): ComputerStatus {
  return { computer: { ...computer }, state: stateOf(inspect), instanceId: inspect.Id };
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

export function createDockerComputerProvider(
  options: DockerComputerProviderOptions,
): ComputerProvider {
  if (options.image.trim() === "") {
    throw new RangeError("the Docker computer provider needs an image");
  }

  const home = options.home ?? DEFAULT_DOCKER_COMPUTER_HOME;

  if (!home.startsWith("/") || home === "/") {
    throw new RangeError(`home must be an absolute path below the root, received "${home}"`);
  }

  const snapshotDirectory = options.snapshotDirectory ?? DEFAULT_DOCKER_SNAPSHOT_DIRECTORY;
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

  async function ensureImage(budgetMs: number): Promise<void> {
    const present = await guarded(engine.imageExists(options.image, budgetMs), "image");

    if (present && pullPolicy !== "always") {
      return;
    }

    if (pullPolicy === "never") {
      throw new ComputerProviderError(
        "not_found",
        `the image "${options.image}" is not present and pulling is disabled`,
      );
    }

    await guarded(engine.pullImage(options.image, archiveTimeoutMs), "image");
  }

  async function waitReady(id: string, budgetMs: number): Promise<DockerContainerInspect> {
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
        return inspect;
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

  function snapshotFile(key: string): string | undefined {
    const match = snapshotKeyPattern.exec(key);

    if (match === null) {
      return undefined;
    }

    // The key is scope-checked against the computer before a path is built, so
    // a hand-assembled key cannot point at another machine's archive or escape
    // the snapshot directory.
    return path.join(snapshotDirectory, match[1] ?? "", `${match[2] ?? ""}.tar`);
  }

  return {
    async ensure(computer: ComputerRef): Promise<ComputerStatus> {
      const network = planFor(computer);
      const existing = await inspectFor(computer);

      if (existing !== undefined && existing.State?.Running === true) {
        return statusOf(computer, await waitReady(existing.Id, bootTimeoutMs));
      }

      let id: string;

      if (existing === undefined) {
        await ensureImage(requestTimeoutMs);
        await guarded(engine.ensureNetwork(network, requestTimeoutMs), "network");
        id = await createFor(computer, network.name);
      } else {
        id = existing.Id;
      }

      await engine
        .startContainer(id, bootTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      return statusOf(computer, await waitReady(id, bootTimeoutMs));
    },

    async status(computer: ComputerRef): Promise<ComputerStatus> {
      const inspect = await inspectFor(computer);

      return inspect === undefined
        ? { computer: { ...computer }, state: "gone" }
        : statusOf(computer, inspect);
    },

    async stop(computer: ComputerRef): Promise<ComputerStatus> {
      const inspect = await inspectFor(computer);

      if (inspect === undefined || inspect.State?.Running !== true) {
        return inspect === undefined
          ? { computer: { ...computer }, state: "gone" }
          : statusOf(computer, inspect);
      }

      await engine
        .stopContainer(inspect.Id, 10, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      const stopped = await inspectFor(computer);

      return stopped === undefined
        ? { computer: { ...computer }, state: "gone" }
        : statusOf(computer, stopped);
    },

    async list(): Promise<readonly ComputerStatus[]> {
      const summaries = await guarded(
        engine.listContainers({ [dockerComputerLabels.managed]: "true" }, requestTimeoutMs),
        "container",
      );
      const statuses: ComputerStatus[] = [];

      for (const summary of summaries) {
        const computer = refFromLabels(summary.Labels);

        if (computer === undefined) {
          continue;
        }

        statuses.push({
          computer,
          state: summary.State === "running" ? "running" : "stopped",
          instanceId: summary.Id,
        });
      }

      return statuses;
    },

    async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
        throw new RangeError(
          `timeoutMs must be a positive integer of milliseconds, received ${String(request.timeoutMs)}`,
        );
      }

      const result = await engine
        .exec({
          containerId: containerName(request.computer),
          command: request.command,
          workingDirectory: home,
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

    async snapshot(computer: ComputerRef): Promise<ComputerSnapshot> {
      const inspect = await inspectFor(computer);

      if (inspect === undefined) {
        throw new ComputerProviderError(
          "gone",
          `no computer ${computer.computerId} is provisioned`,
        );
      }

      const scope = snapshotScope(computer);
      const snapshotId = randomUUID();
      const directory = path.join(snapshotDirectory, scope);
      const file = path.join(directory, `${snapshotId}.tar`);

      await mkdir(directory, { recursive: true });

      try {
        const archive = await engine
          .getArchive(inspect.Id, home, archiveTimeoutMs)
          .catch((error: unknown) => failure(error, "archive"));
        await pipeline(archive.stream, createWriteStream(file));
      } catch (error) {
        await rm(file, { force: true }).catch(() => undefined);
        // A stream that failed mid-copy is a transport fault, and an already
        // classified failure passes through with its kind intact.
        failure(error, "archive");
      }

      return { snapshotId, key: `${scope}/${snapshotId}.tar` };
    },

    async restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus> {
      const network = planFor(computer);
      const file = snapshotFile(snapshot.key);

      if (
        file === undefined ||
        snapshot.key !== `${snapshotScope(computer)}/${snapshot.snapshotId}.tar` ||
        snapshot.snapshotId.trim() === ""
      ) {
        throw new ComputerProviderError(
          "not_found",
          `no snapshot is stored under "${snapshot.key}" for this computer`,
        );
      }

      const archive = await stat(file).catch(() => undefined);

      if (archive === undefined || !archive.isFile()) {
        throw new ComputerProviderError(
          "not_found",
          `no snapshot archive exists at "${snapshot.key}"`,
        );
      }

      await ensureImage(requestTimeoutMs);
      await guarded(engine.ensureNetwork(network, requestTimeoutMs), "network");

      // Restore means the snapshot wins: the old container and its home are
      // replaced, so nothing the snapshot does not carry can survive into the
      // restored machine, and then the archive is streamed back into the
      // fresh home before the machine starts.
      const existing = await inspectFor(computer);

      if (existing !== undefined) {
        await engine
          .removeContainer(existing.Id, { force: true }, requestTimeoutMs)
          .catch((error: unknown) => failure(error, "container"));
      }

      await engine
        .removeVolume(volumeName(computer), requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      const id = await createFor(computer, network.name);
      const stream = createReadStream(file);

      try {
        await engine
          .putArchive(id, path.dirname(home), { stream, length: archive.size }, archiveTimeoutMs)
          .catch((error: unknown) => failure(error, "archive"));

        await engine
          .startContainer(id, bootTimeoutMs)
          .catch((error: unknown) => failure(error, "container"));
      } catch (error) {
        // A restore that failed after the old home was replaced leaves no
        // half-booted machine behind: the clean container is removed, so the
        // next attempt starts from gone rather than from an empty home.
        await engine.removeContainer(id, { force: true }, requestTimeoutMs).catch(() => undefined);
        throw error;
      }

      return statusOf(computer, await waitReady(id, bootTimeoutMs));
    },

    async destroy(computer: ComputerRef): Promise<void> {
      const inspect = await inspectFor(computer);

      if (inspect === undefined) {
        return;
      }

      // The named home volume is deliberately not removed: the bot's home is
      // what a reset keeps, and what a snapshot is for.
      await engine
        .removeContainer(inspect.Id, { force: true }, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));
    },
  };
}
