import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { SafeFetch } from "@porkbot/effect";
import { safeFetch } from "@porkbot/effect";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  StorageProvider,
} from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";
import { quoteShellArgument } from "./computer-conformance.ts";
import {
  createComputerSnapshotStore,
  DEFAULT_COMPUTER_ARCHIVE_DIRECTORY,
} from "./computer-snapshot-store.ts";
import { computerIdentityHash, createRuntimeComputerProvider } from "./computer-runtime.ts";
import type {
  ComputerListedMachine,
  ComputerMachine,
  ComputerRuntime,
} from "./computer-runtime.ts";
import { createDaytonaEngine } from "./daytona-engine.ts";
import type { DaytonaEngine, DaytonaSandbox } from "./daytona-engine.ts";
import { classifyDaytonaFailure, DaytonaProtocolError } from "./daytona-errors.ts";

/**
 * The Daytona computer provider (slice 7.3, PRD decisions 19 and 20; stories 27,
 * 29 and 31).
 *
 * The cloud implementation of `ComputerProvider`: one Daytona sandbox per bot,
 * created from a template image, labelled so the provider can enumerate exactly
 * its own machines, parked with `stop` (Daytona keeps a stopped sandbox's
 * filesystem, so the agent home survives), and destroyed only by an explicit
 * lifecycle call. It is chosen per bot through the bot's computer settings; the
 * endpoint and key are the deployment's generic computer connection, never a
 * vendor-named variable (the module map's provider rules).
 *
 * Why Daytona and not E2B or Box: its control plane and its sandbox toolbox are
 * plain REST + JSON with a published OpenAPI document, so the adapter — and its
 * offline emulator — speak the real wire without generating a Connect/gRPC
 * client, and an operator can self-host the same API. `start`/`stop`/`recover`
 * map onto `ensure`/`stop` and the recovery path, resources (`cpu`, `memory`,
 * `disk`) map onto the per-bot ceilings, and the toolbox's `process/execute`
 * plus file download/upload give snapshot and restore the same bytes Docker's
 * archive API gives. E2B's sandbox lifecycle is equally good but its command
 * and filesystem protocol is Connect streaming over a generated client, and
 * Box is a content cloud rather than a sandbox provider; both would have made
 * the offline emulator speak a protocol this adapter could not hand-write
 * honestly.
 *
 * This file is the Daytona runtime over the shared lifecycle in
 * `computer-runtime.ts`: the same `ensure`/`stop`/`snapshot`/`restore`
 * composition the Docker provider uses, so "the computer is gone", "a retry is
 * idempotent" and the snapshot key rules have one implementation. Failure
 * mapping is `classifyDaytonaFailure` alone (slice 7.3, PRD decision 19); this
 * file reads no Daytona status and no Daytona message.
 *
 * What survives what: `stop` parks the sandbox and keeps its filesystem;
 * `remove` deletes it, so the home's durability is the snapshot path — capture
 * writes the home's tar through the toolbox into a staging file, the shared
 * snapshot store puts it through the storage seam, and restore replays the
 * verified archive into a fresh sandbox. The home-sync story
 * in `@porkbot/adapter-kit` states that contract for the backup slice.
 */

/** The resource slice one sandbox runs inside; per-bot overridable. */
export interface DaytonaComputerCeilings {
  /** Whole vCPU cores; Daytona's smallest sandbox is one. */
  readonly cpus: number;
  /** Memory in mebibytes; Daytona sizes sandboxes in whole gibibytes. */
  readonly memoryMb: number;
  /** Disk in mebibytes; Daytona sizes sandboxes in whole gibibytes. */
  readonly diskMb: number;
}

/**
 * One bot's share of the documented host floor, in Daytona's granularity.
 * Daytona's own minimums are 1 vCPU, 1 GiB of memory and 3 GiB of disk; a
 * ceiling below that is rounded up rather than refused, because the floor is
 * the provider's to enforce.
 */
export const DEFAULT_DAYTONA_CEILINGS: DaytonaComputerCeilings = {
  cpus: 1,
  memoryMb: 2048,
  diskMb: 10_240,
};

/** The home directory a sandbox starts in, unless configured otherwise. */
export const DEFAULT_DAYTONA_COMPUTER_HOME = "/home/agent";

/** The labels every managed sandbox carries, so `list` finds exactly ours. */
export const daytonaComputerLabels = {
  managed: "porkbot.managed",
  computerId: "porkbot.computer.id",
  botId: "porkbot.bot.id",
} as const;

export interface DaytonaComputerProviderOptions {
  /** The control plane's base URL, for example `https://app.daytona.io/api`. */
  readonly endpoint: string;
  /** The toolbox base URL; the control plane's `/toolbox` by default. */
  readonly toolboxUrl?: string | undefined;
  /** The API key. Never logged, never a field of a status or an error. */
  readonly token: string;
  /** The image or snapshot a sandbox boots from; the deployment's machine contract. */
  readonly image: string;
  /** The agent's home directory inside the sandbox. */
  readonly home?: string | undefined;
  /** How long `ensure` waits for a sandbox to become ready, in milliseconds. */
  readonly bootTimeoutMs?: number | undefined;
  /** The budget for one control-plane call, in milliseconds. */
  readonly requestTimeoutMs?: number | undefined;
  /** How long a snapshot or restore archive may take, in milliseconds. */
  readonly archiveTimeoutMs?: number | undefined;
  /** The most output one command may return, in characters. */
  readonly maxOutputBytes?: number | undefined;
  /** Defaults merged with per-bot overrides; a function gets the full reference. */
  readonly ceilings?:
    | Partial<DaytonaComputerCeilings>
    | ((computer: ComputerRef) => Partial<DaytonaComputerCeilings>)
    | undefined;
  /**
   * The storage seam every snapshot archive is written through (slice 7.5).
   * Required: a provider with nowhere durable to put an archive would answer
   * `snapshot` with bytes it cannot keep, which is worse than saying so.
   */
  readonly storage: StorageProvider;
  /** Where an archive is staged while it is written or verified. */
  readonly scratchDirectory?: string | undefined;
  /** Injected for tests; built from the endpoint options when absent. */
  readonly engine?: DaytonaEngine | undefined;
  /**
   * Transport seam for the offline wire emulator, which speaks plain HTTP on
   * loopback; defaults to the URL-safety module's `safeFetch`, so a shipped
   * deployment only ever dials an HTTPS endpoint whose resolved address is
   * public (PRD decision 23).
   */
  readonly fetch?: SafeFetch | undefined;
}

function sandboxName(computer: ComputerRef): string {
  return `porkbot-computer-${computerIdentityHash(`${computer.botId}\u0000${computer.computerId}`)}`;
}

function assertCeilings(ceilings: DaytonaComputerCeilings): void {
  const values: readonly (readonly [string, number])[] = [
    ["cpus", ceilings.cpus],
    ["memoryMb", ceilings.memoryMb],
    ["diskMb", ceilings.diskMb],
  ];

  for (const [name, value] of values) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`computer ceiling ${name} must be a positive number, received ${value}`);
    }
  }
}

function refFromLabels(
  labels: Readonly<Record<string, string>> | undefined,
): ComputerRef | undefined {
  const computerId = labels?.[daytonaComputerLabels.computerId];
  const botId = labels?.[daytonaComputerLabels.botId];

  if (typeof computerId !== "string" || computerId.trim() === "") {
    return undefined;
  }

  if (typeof botId !== "string" || botId.trim() === "") {
    return undefined;
  }

  return { computerId, botId };
}

/** The sandbox states that mean a live machine the lifecycle can act on. */
const runningStates = new Set([
  "started",
  "starting",
  "resuming",
  "restoring",
  "creating",
  "pulling_snapshot",
  "building_snapshot",
  "pending_build",
  "snapshotting",
  "resizing",
  "forking",
  "pausing",
]);

/** The sandbox states the provider still holds but that are not running. */
const parkedStates = new Set([
  "stopped",
  "stopping",
  "paused",
  "archiving",
  "archived",
  "error",
  "build_failed",
]);

function machineOf(sandbox: DaytonaSandbox): ComputerMachine | undefined {
  if (runningStates.has(sandbox.state)) {
    return { instanceId: sandbox.id, state: "running" };
  }

  if (parkedStates.has(sandbox.state)) {
    return { instanceId: sandbox.id, state: "stopped" };
  }

  // `destroyed`, `destroying`, `deleted` and `unknown`: the provider does not
  // hold a machine this reference can act on.
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Collects a stream into a string; used for the stderr file exec reads back. */
async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function truncate(output: string, maxOutputBytes: number): string {
  return output.length > maxOutputBytes
    ? `${output.slice(0, maxOutputBytes)}\n[output truncated]`
    : output;
}

/** Builds the runtime over one Daytona connection; the factory owns the seam. */
function createDaytonaRuntime(options: DaytonaComputerProviderOptions): ComputerRuntime {
  if (options.image.trim() === "") {
    throw new RangeError("the Daytona computer provider needs an image");
  }

  if (options.token.trim() === "") {
    throw new RangeError("the Daytona computer provider needs an API token");
  }

  const home = options.home ?? DEFAULT_DAYTONA_COMPUTER_HOME;

  if (!home.startsWith("/") || home === "/") {
    throw new RangeError(`home must be an absolute path below the root, received "${home}"`);
  }

  const bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const archiveTimeoutMs = options.archiveTimeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 262_144;
  const defaults = {
    ...DEFAULT_DAYTONA_CEILINGS,
    ...(typeof options.ceilings === "function" ? {} : (options.ceilings ?? {})),
  };
  assertCeilings(defaults);

  const engine =
    options.engine ??
    createDaytonaEngine({
      endpoint: options.endpoint,
      toolboxUrl: options.toolboxUrl,
      token: options.token,
      requestTimeoutMs,
      fetch: options.fetch ?? safeFetch,
    });

  function ceilingsFor(computer: ComputerRef): DaytonaComputerCeilings {
    const overrides = typeof options.ceilings === "function" ? options.ceilings(computer) : {};
    const merged = { ...defaults, ...overrides };

    assertCeilings(merged);
    return merged;
  }

  function failure(error: unknown, subject: Parameters<typeof classifyDaytonaFailure>[1]): never {
    throw classifyDaytonaFailure(error, subject);
  }

  async function inspectFor(computer: ComputerRef): Promise<DaytonaSandbox | undefined> {
    return await engine
      .getSandbox(sandboxName(computer), requestTimeoutMs)
      .catch((error: unknown) => failure(error, "sandbox"));
  }

  async function waitReady(machine: ComputerMachine, budgetMs: number): Promise<ComputerMachine> {
    const deadline = Date.now() + budgetMs;

    for (;;) {
      const sandbox = await engine
        .getSandbox(machine.instanceId, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "sandbox"));

      if (sandbox === undefined) {
        throw new ComputerProviderError(
          "gone",
          "the machine disappeared while booting; re-read its state",
        );
      }

      const current = machineOf(sandbox);

      if (current !== undefined && current.state === "running" && sandbox.state === "started") {
        return current;
      }

      if (sandbox.state === "error" || sandbox.state === "build_failed") {
        throw new ComputerProviderError(
          "gone",
          "the machine entered an error state while booting; recover it before reuse",
        );
      }

      if (current === undefined) {
        throw new ComputerProviderError(
          "gone",
          "the machine was destroyed while booting; re-read its state",
        );
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

  /** Makes a parked or errored sandbox run; idempotent on a running one. */
  async function startFor(
    machine: ComputerMachine,
    computer: ComputerRef,
  ): Promise<ComputerMachine> {
    const sandbox = await inspectFor(computer);

    if (sandbox === undefined) {
      throw new ComputerProviderError(
        "gone",
        "the machine disappeared before it could start; re-read its state",
      );
    }

    const current = machineOf(sandbox);

    // Already running, or still in a boot transition: start is idempotent.
    if (current !== undefined && current.state === "running") {
      return current;
    }

    const started =
      sandbox.state === "error" || sandbox.state === "build_failed"
        ? await engine
            .recoverSandbox(machine.instanceId, requestTimeoutMs)
            .catch((error: unknown) => failure(error, "sandbox"))
        : await engine
            .startSandbox(machine.instanceId, requestTimeoutMs)
            .catch((error: unknown) => failure(error, "sandbox"));

    return machineOf(started) ?? machine;
  }

  /** One toolbox command whose refusal is the archive path's classification. */
  async function runArchiveCommand(machineId: string, command: string): Promise<void> {
    const result = await engine
      .exec(
        machineId,
        { command, cwd: home, timeoutMs: archiveTimeoutMs },
        archiveTimeoutMs + 5_000,
      )
      .catch((error: unknown) => failure(error, "archive"));

    if (result.exitCode !== 0) {
      // The archive's tar ran and refused; the output is not echoed because a
      // command's output is untrusted content, and the detail stays
      // operator-safe.
      throw new ComputerProviderError(
        "not_found",
        "the home archive command failed inside the machine",
      );
    }
  }

  return {
    async find(computer: ComputerRef): Promise<ComputerMachine | undefined> {
      const sandbox = await inspectFor(computer);

      return sandbox === undefined ? undefined : machineOf(sandbox);
    },

    async list(): Promise<readonly ComputerListedMachine[]> {
      const sandboxes = await engine
        .listSandboxes(requestTimeoutMs)
        .catch((error: unknown) => failure(error, "sandbox"));
      const listed: ComputerListedMachine[] = [];

      for (const sandbox of sandboxes) {
        if (sandbox.labels?.[daytonaComputerLabels.managed] !== "true") {
          continue;
        }

        const computer = refFromLabels(sandbox.labels);
        const machine = machineOf(sandbox);

        if (computer === undefined || machine === undefined) {
          continue;
        }

        listed.push({ computer, machine });
      }

      return listed;
    },

    async prepare(): Promise<void> {
      // The control plane resolves the image when the sandbox is created;
      // there is nothing to pull or attach before that.
    },

    async create(computer: ComputerRef): Promise<ComputerMachine> {
      const ceilings = ceilingsFor(computer);
      const spec = {
        source: options.image,
        name: sandboxName(computer),
        labels: {
          [daytonaComputerLabels.managed]: "true",
          [daytonaComputerLabels.computerId]: computer.computerId,
          [daytonaComputerLabels.botId]: computer.botId,
        },
        cpu: Math.ceil(ceilings.cpus),
        memory: Math.ceil(ceilings.memoryMb / 1_024),
        disk: Math.ceil(ceilings.diskMb / 1_024),
      };

      let sandbox: DaytonaSandbox;

      try {
        sandbox = await engine.createSandbox(spec, requestTimeoutMs);
      } catch (error) {
        // Two ensures can race on a cold boot. Instead of reading the
        // service's conflict status, this re-reads the name: a sandbox that
        // appeared is adopted as the idempotent answer, and anything else is
        // classified.
        const adopted = await engine.getSandbox(spec.name, requestTimeoutMs).catch(() => undefined);

        if (adopted !== undefined) {
          const machine = machineOf(adopted);

          if (machine !== undefined) {
            return machine;
          }
        }

        failure(error, "sandbox");
      }

      const machine = machineOf(sandbox);

      if (machine === undefined) {
        throw new DaytonaProtocolError("a created sandbox reported no live state");
      }

      return machine;
    },

    async start(machine: ComputerMachine, computer: ComputerRef): Promise<ComputerMachine> {
      return await startFor(machine, computer);
    },

    async stop(machine: ComputerMachine): Promise<ComputerMachine | undefined> {
      const stopped = await engine
        .stopSandbox(machine.instanceId, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "sandbox"));

      return stopped === undefined ? undefined : machineOf(stopped);
    },

    async remove(machine: ComputerMachine): Promise<void> {
      await engine
        .deleteSandbox(machine.instanceId, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "sandbox"));
    },

    async ready(
      machine: ComputerMachine,
      _computer: ComputerRef,
      budgetMs: number,
    ): Promise<ComputerMachine> {
      return await waitReady(machine, budgetMs);
    },

    async exec(
      machine: ComputerMachine,
      _computer: ComputerRef,
      request: ComputerExecRequest,
    ): Promise<ComputerExecResult> {
      // The toolbox returns one combined stream, so stderr is redirected to a
      // file inside the sandbox and read back: the seam reports the two
      // streams separately, and a caller that branches on stderr cannot be
      // handed output that might have been stdout. `sh -c` groups the
      // caller's command as one unit, so the redirect applies to all of it.
      const stderrPath = `/tmp/porkbot-stderr-${randomUUID()}`;
      const command = `sh -c ${quoteShellArgument(request.command)} 2> ${quoteShellArgument(stderrPath)}`;
      const result = await engine
        .exec(machine.instanceId, { command, cwd: home, timeoutMs: request.timeoutMs })
        .catch((error: unknown) => failure(error, "command"));
      const stderrFile = await engine
        .downloadFile(machine.instanceId, stderrPath, requestTimeoutMs)
        .catch((error: unknown) => failure(error, "command"));
      const stderr =
        stderrFile === undefined ? "" : await readStream(stderrFile.stream).catch(() => "");
      await engine
        .deleteFile(machine.instanceId, stderrPath, requestTimeoutMs)
        .catch(() => undefined);

      // The bound is applied here so a runaway command cannot hand the run an
      // unbounded string; the toolbox itself does not bound output.
      return {
        exitCode: result.exitCode,
        stdout: truncate(result.result, maxOutputBytes),
        stderr: truncate(stderr, maxOutputBytes),
      };
    },

    async readHome(machine: ComputerMachine, computer: ComputerRef, destination: string) {
      // An idle sweep may have parked the machine; the archive runs on a
      // running sandbox, so this is where a snapshot of a parked one wakes it.
      await waitReady(await startFor(machine, computer), bootTimeoutMs);

      const archivePath = `/tmp/porkbot-snapshot-${randomUUID()}.tar`;

      await runArchiveCommand(
        machine.instanceId,
        `tar -cf ${quoteShellArgument(archivePath)} -C ${quoteShellArgument(home)} .`,
      );

      const archive = await engine
        .downloadFile(machine.instanceId, archivePath, archiveTimeoutMs)
        .catch((error: unknown) => failure(error, "archive"));

      if (archive === undefined) {
        throw new ComputerProviderError(
          "not_found",
          "the home archive the machine wrote could not be read back",
        );
      }

      try {
        await pipeline(archive.stream, createWriteStream(destination));
      } catch (error) {
        failure(error, "archive");
      }

      await engine
        .deleteFile(machine.instanceId, archivePath, requestTimeoutMs)
        .catch(() => undefined);
    },

    async writeHome(
      machine: ComputerMachine,
      computer: ComputerRef,
      source: string,
      byteLength: number,
    ) {
      // A sandbox accepts toolbox calls only once it is up, and `create` has
      // only begun the boot; the wait here is what makes restore sound.
      await waitReady(await startFor(machine, computer), bootTimeoutMs);

      const archivePath = `/tmp/porkbot-restore-${randomUUID()}.tar`;
      const stream = createReadStream(source);

      await engine
        .uploadFile(
          machine.instanceId,
          archivePath,
          { stream, length: byteLength },
          archiveTimeoutMs,
        )
        .catch((error: unknown) => failure(error, "archive"));

      await runArchiveCommand(
        machine.instanceId,
        `mkdir -p ${quoteShellArgument(home)} && tar -xf ${quoteShellArgument(archivePath)} -C ${quoteShellArgument(home)}`,
      );

      await engine
        .deleteFile(machine.instanceId, archivePath, requestTimeoutMs)
        .catch(() => undefined);
    },
  };
}

export function createDaytonaComputerProvider(
  options: DaytonaComputerProviderOptions,
): ComputerProvider {
  return createRuntimeComputerProvider({
    runtime: createDaytonaRuntime(options),
    snapshots: createComputerSnapshotStore({
      storage: options.storage,
      scratchDirectory: options.scratchDirectory ?? DEFAULT_COMPUTER_ARCHIVE_DIRECTORY,
    }),
    bootTimeoutMs: options.bootTimeoutMs,
  });
}
