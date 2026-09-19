import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { assertComputerNetworkPlan, planComputerNetwork } from "@porkbot/core";
import type { ComputerNetworkPlan } from "@porkbot/core";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ComputerState,
  StorageProvider,
} from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";
import {
  createComputerSnapshotStore,
  DEFAULT_COMPUTER_ARCHIVE_DIRECTORY,
} from "./computer-snapshot-store.ts";
import { createDockerEngine } from "./docker-engine.ts";
import type { DockerContainerInspect, DockerEngine } from "./docker-engine.ts";
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
  /** Injected for tests; built from the endpoint options when absent. */
  readonly engine?: DockerEngine | undefined;
}

function containerName(computer: ComputerRef): string {
  return `porkbot-computer-${computerIdentityHash(`${computer.botId}\u0000${computer.computerId}`)}`;
}

function volumeName(computer: ComputerRef): string {
  return `porkbot-home-${computerIdentityHash(`${computer.botId}\u0000${computer.computerId}`)}`;
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

/** Builds the runtime over one daemon; `createDockerComputerProvider` owns the seam. */
function createDockerRuntime(options: DockerComputerProviderOptions): ComputerRuntime {
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

  return {
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
      await ensureImage(requestTimeoutMs);
      await guarded(engine.ensureNetwork(planFor(computer), requestTimeoutMs), "network");
    },

    async create(computer: ComputerRef): Promise<ComputerMachine> {
      const network = planFor(computer);
      const id = await createFor(computer, network.name);

      return { instanceId: id, state: "stopped" };
    },

    async start(machine: ComputerMachine): Promise<ComputerMachine> {
      await engine
        .startContainer(machine.instanceId, bootTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      return { instanceId: machine.instanceId, state: "running" };
    },

    async stop(machine: ComputerMachine): Promise<ComputerMachine | undefined> {
      await engine
        .stopContainer(machine.instanceId, 10, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      const stopped = await engine
        .inspectContainer(machine.instanceId, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));

      return stopped === undefined ? undefined : machineOf(stopped);
    },

    async remove(machine: ComputerMachine): Promise<void> {
      await engine
        .removeContainer(machine.instanceId, { force: true }, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "container"));
    },

    async ready(machine: ComputerMachine, _computer: ComputerRef, budgetMs: number) {
      return await waitReady(machine.instanceId, budgetMs);
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
}

export function createDockerComputerProvider(
  options: DockerComputerProviderOptions,
): ComputerProvider {
  return createRuntimeComputerProvider({
    runtime: createDockerRuntime(options),
    snapshots: createComputerSnapshotStore({
      storage: options.storage,
      scratchDirectory: options.scratchDirectory ?? DEFAULT_COMPUTER_ARCHIVE_DIRECTORY,
    }),
    bootTimeoutMs: options.bootTimeoutMs,
  });
}
