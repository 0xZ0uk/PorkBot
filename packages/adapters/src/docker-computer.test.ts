import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProviderFailure } from "@porkbot/adapter-kit";
import type { ComputerRef, ProviderFailure } from "@porkbot/adapter-kit";
import { planComputerNetwork } from "@porkbot/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDockerComputerProvider,
  DEFAULT_COMPUTER_CEILINGS,
  DEFAULT_COMPUTER_LOG_CONFIG,
} from "./docker-computer.ts";
import type { DockerComputerProvider } from "./docker-computer.ts";
import { DockerEngineEmulator } from "./docker-engine-emulator.ts";
import { LocalStorageProvider } from "./local-storage.ts";

/**
 * The Docker computer provider (slice 7.2). Every test drives the shipped
 * provider through the Engine API emulator on its unix socket: the same HTTP
 * the provider sends a real daemon crosses this suite, so lifecycle, the
 * classifier, the ceilings, the isolation plan and the snapshot round-trip are
 * exercised with no daemon and no network. The conformance suite runs against
 * a real daemon in `apps/supervisor/test/integration`.
 */

const image = "porkbot-test-computer:1";
const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };
const otherComputer: ComputerRef = { computerId: "computer-2", botId: "bot-2" };

const running: DockerEngineEmulator[] = [];
const snapshotRoots: string[] = [];

async function emulator(): Promise<DockerEngineEmulator> {
  const started = await DockerEngineEmulator.start();
  running.push(started);
  return started;
}

/** A real local directory for the storage root or the staging area, removed with each test. */
function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  snapshotRoots.push(directory);
  return directory;
}

/** The provider with its own endpoint wiring: the socket is the emulator's. */
function providerOver(
  daemon: DockerEngineEmulator,
  overrides: Partial<Parameters<typeof createDockerComputerProvider>[0]> = {},
): DockerComputerProvider {
  return createDockerComputerProvider({
    image,
    socketPath: daemon.socketPath,
    storage: new LocalStorageProvider({ root: tempDirectory("porkbot-docker-storage-") }),
    scratchDirectory: tempDirectory("porkbot-docker-archives-"),
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (instance) => instance.stop()));
  for (const directory of snapshotRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function failureFrom(call: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await call;
  } catch (error) {
    if (!isProviderFailure(error)) {
      throw new Error(`expected a ProviderFailure, received ${String(error)}`, { cause: error });
    }

    return error;
  }

  throw new Error("expected the call to fail");
}

function createBodies(daemon: DockerEngineEmulator): readonly {
  readonly HostConfig?: Record<string, unknown>;
  readonly Labels?: Record<string, string>;
}[] {
  return daemon.requests
    .filter((entry) => entry.method === "POST" && entry.path.startsWith("/containers/create"))
    .map(
      (entry) =>
        entry.body as { HostConfig?: Record<string, unknown>; Labels?: Record<string, string> },
    );
}

function execCommand(daemon: DockerEngineEmulator): readonly string[] {
  const request = daemon.requests.find(
    (entry) =>
      entry.method === "POST" &&
      entry.path.includes("/exec") &&
      typeof entry.body === "object" &&
      entry.body !== null &&
      Array.isArray((entry.body as { readonly Cmd?: unknown }).Cmd),
  );

  return (request?.body as { readonly Cmd?: readonly string[] } | undefined)?.Cmd ?? [];
}

describe("the Docker computer provider lifecycle", () => {
  it("boots a missing machine to ready, idempotently, through the daemon", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);

    const first = await provider.ensure(computer);
    const second = await provider.ensure(computer);

    expect(first).toMatchObject({ computer, state: "running" });
    expect(second.state).toBe("running");
    await expect(provider.status(computer)).resolves.toMatchObject({ state: "running" });
    expect(daemon.imageNames).toContain(image);
    expect(createBodies(daemon)).toHaveLength(1);
  });

  it("answers a computer the daemon has never seen as gone", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);

    await expect(provider.status(computer)).resolves.toMatchObject({ state: "gone" });
    await expect(provider.stop(computer)).resolves.toMatchObject({ state: "gone" });
  });

  it("parks a machine with stop and brings it back with ensure, home intact", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);
    daemon.writeFile("/home/agent/parked.txt", "survives a stop\n");

    await expect(provider.stop(computer)).resolves.toMatchObject({ state: "stopped" });
    await expect(provider.status(computer)).resolves.toMatchObject({ state: "stopped" });

    // A parked machine has no live instance to command.
    const stopped = await failureFrom(
      provider.exec({ computer, command: "printf 'x'", timeoutMs: 1_000 }),
    );
    expect(stopped.kind).toBe("gone");

    await expect(provider.ensure(computer)).resolves.toMatchObject({ state: "running" });
    expect([...daemon.volumes().values()][0]?.get("/home/agent/parked.txt")).toBe(
      "survives a stop\n",
    );

    // Stopping a machine that does not exist is a status report, not an error.
    await expect(provider.stop({ computerId: "never", botId: "bot-1" })).resolves.toMatchObject({
      state: "gone",
    });
  });

  it("removes the container and its network on destroy and keeps the home for reset", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);
    daemon.writeFile("/home/agent/kept.txt", "kept");

    await provider.destroy(computer);
    await expect(provider.destroy(computer)).resolves.toBeUndefined();
    await expect(provider.status(computer)).resolves.toMatchObject({ state: "gone" });

    const failure = await failureFrom(
      provider.exec({ computer, command: "printf 'x'", timeoutMs: 1_000 }),
    );

    expect(failure.kind).toBe("gone");
    expect([...daemon.volumes().values()][0]?.get("/home/agent/kept.txt")).toBe("kept");
    // The isolation network ends with the machine: the daemon's subnet pools
    // are finite, and a network that outlived its computer is a boot failure
    // waiting for the next one.
    expect(daemon.networks()).toEqual([]);
  });

  it("lists every machine it holds and forgets the ones it destroyed", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);

    await provider.ensure(computer);
    await provider.ensure(otherComputer);
    await provider.stop(otherComputer);

    expect(await provider.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ computer, state: "running" }),
        expect.objectContaining({ computer: otherComputer, state: "stopped" }),
      ]),
    );

    await provider.destroy(computer);

    const remaining = await provider.list();

    expect(remaining).toEqual(
      expect.arrayContaining([expect.objectContaining({ computer: otherComputer })]),
    );
    expect(remaining.some((status) => status.computer.computerId === computer.computerId)).toBe(
      false,
    );
  });

  it("bounds boot and reports timed_out when the machine never becomes ready", async () => {
    const daemon = await emulator();
    daemon.stallBoot(500);
    const provider = providerOver(daemon, { bootTimeoutMs: 10 });

    const failure = await failureFrom(provider.ensure(computer));

    expect(failure.kind).toBe("timed_out");
    expect(failure.detail?.trim()).not.toBe("");
  });

  it("adopts a machine that became ready before the boot budget expired", async () => {
    const daemon = await emulator();
    daemon.stallBoot(5);
    const provider = providerOver(daemon, { bootTimeoutMs: 500 });

    await expect(provider.ensure(computer)).resolves.toMatchObject({ state: "running" });
  });
});

describe("the Docker computer provider failure classification", () => {
  it("classifies a registry quota from the pull stream as rate_limited", async () => {
    const daemon = await emulator();
    daemon.failNextPull("toomanyrequests: You have reached your pull rate limit");
    const provider = providerOver(daemon);

    const failure = await failureFrom(provider.ensure(computer));

    expect(failure.kind).toBe("rate_limited");
  });

  it("classifies a refused registry credential as auth_failed", async () => {
    const daemon = await emulator();
    daemon.failNext({
      method: "POST",
      pathIncludes: "/images/create",
      status: 401,
      message: "unauthorized: authentication required",
    });
    const provider = providerOver(daemon);

    const failure = await failureFrom(provider.ensure(computer));

    expect(failure.kind).toBe("auth_failed");
  });

  it("classifies a daemon refusal on a lifecycle call as rate_limited on 429", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);
    await provider.stop(computer);
    daemon.failNext({
      method: "POST",
      pathIncludes: "/start",
      status: 429,
      message: "too many requests",
    });

    const failure = await failureFrom(provider.ensure(computer));

    expect(failure.kind).toBe("rate_limited");
  });

  it("refuses to pull when pulling is disabled and the image is absent", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon, { pullPolicy: "never" });

    const failure = await failureFrom(provider.ensure(computer));

    expect(failure.kind).toBe("not_found");
    expect(daemon.requests.some((entry) => entry.path.startsWith("/images/create"))).toBe(false);
  });

  it("refuses an unknown snapshot as not_found before touching the daemon", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);

    const failure = await failureFrom(
      provider.restore(computer, {
        snapshotId: "00000000-0000-4000-8000-000000000000",
        key: "computer-snapshots/0123456789abcdef/00000000-0000-4000-8000-000000000000.tar",
        size: 1,
        checksum: "0".repeat(64),
      }),
    );

    expect(failure.kind).toBe("not_found");
  });
});

describe("the Docker computer provider isolation and ceilings", () => {
  it("creates the planned network with an isolated gateway and attaches only there", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);

    const plan = planComputerNetwork(computer);

    expect(daemon.networks()).toEqual([
      { name: plan.name, driver: plan.driver, internal: true, gatewayMode: "isolated" },
    ]);
    expect(createBodies(daemon)[0]?.HostConfig?.["NetworkMode"]).toBe(plan.name);
    // A real init reaps exec'd zombies and forwards the stop signal.
    expect(createBodies(daemon)[0]?.HostConfig?.["Init"]).toBe(true);
  });

  it("applies the default ceilings to the container and per-bot overrides beside them", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon, {
      ceilings: (ref) =>
        ref.computerId === computer.computerId
          ? {
              cpus: 2,
              memoryMb: 4096,
              pids: 64,
              logConfig: { maxSize: "20m", maxFile: "5" },
            }
          : {},
    });

    await provider.ensure(computer);
    await provider.ensure(otherComputer);

    const [first, second] = createBodies(daemon);
    const mib = 1024 * 1024;
    const defaultMemory = DEFAULT_COMPUTER_CEILINGS.memoryMb * mib;
    const defaultSwap = DEFAULT_COMPUTER_CEILINGS.swapMb * mib;

    expect(first?.HostConfig?.["NanoCpus"]).toBe(2_000_000_000);
    expect(first?.HostConfig?.["Memory"]).toBe(4096 * mib);
    // Raising one bot's memory leaves its swap bound where it was: swap is
    // bounded independently of the memory ceiling, and smaller than it.
    expect(first?.HostConfig?.["MemorySwap"]).toBe(4096 * mib + defaultSwap);
    expect(first?.HostConfig?.["PidsLimit"]).toBe(64);
    // Rotation is a host-floor concern: the log file under
    // /var/lib/docker/containers/<id>/ belongs to the host's disk, and a
    // working agent streams enough to fill it without a ceiling. Every create
    // therefore carries the same bounded json-file policy the stack's own
    // compose services use. The Daytona control plane has no equivalent —
    // sandbox output is returned inline by the toolbox API rather than
    // written to a host-side log file — so the asymmetry is a property of
    // the provider, not an omission.
    expect(first?.HostConfig?.["LogConfig"]).toEqual({
      Type: "json-file",
      Config: { "max-size": "20m", "max-file": "5" },
    });
    expect(second?.HostConfig?.["NanoCpus"]).toBe(DEFAULT_COMPUTER_CEILINGS.cpus * 1_000_000_000);
    expect(second?.HostConfig?.["Memory"]).toBe(defaultMemory);
    // Docker's MemorySwap is memory plus swap, so the create body carries the
    // sum and the swap portion is the independent bound.
    expect(second?.HostConfig?.["MemorySwap"]).toBe(defaultMemory + defaultSwap);
    expect(second?.HostConfig?.["LogConfig"]).toEqual({
      Type: "json-file",
      Config: {
        "max-size": DEFAULT_COMPUTER_LOG_CONFIG.maxSize,
        "max-file": DEFAULT_COMPUTER_LOG_CONFIG.maxFile,
      },
    });
  });

  it("sends a write-layer quota only when the daemon's driver answers it", async () => {
    // The default `auto` posture: an overlay2 daemon that reports no backing
    // filesystem cannot promise a quota, so the create does not pretend one.
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);

    expect(createBodies(daemon)[0]?.HostConfig?.["StorageOpt"]).toBeUndefined();
  });

  it("enforces the budget under auto where the driver answers it, and reports the decision", async () => {
    const daemon = await DockerEngineEmulator.start({
      storageDriver: "overlay2",
      backingFilesystem: "xfs",
    });
    running.push(daemon);

    const provider = providerOver(daemon);
    await provider.ensure(computer);

    expect(createBodies(daemon)[0]?.HostConfig?.["StorageOpt"]).toEqual({
      size: `${String(DEFAULT_COMPUTER_CEILINGS.diskMb)}M`,
    });
    await expect(provider.diskQuota()).resolves.toMatchObject({
      mode: "auto",
      applied: true,
      enforced: true,
      driver: "overlay2",
      backingFilesystem: "xfs",
    });
  });

  it("reports the budget as unenforced under auto when the driver cannot answer it", async () => {
    const daemon = await DockerEngineEmulator.start({
      storageDriver: "overlay2",
      backingFilesystem: "ext4",
    });
    running.push(daemon);

    const provider = providerOver(daemon);
    await provider.ensure(computer);

    expect(createBodies(daemon)[0]?.HostConfig?.["StorageOpt"]).toBeUndefined();
    const decision = await provider.diskQuota();

    expect(decision.enforced).toBe(false);
    expect(decision.applied).toBe(false);
    expect(decision.detail).toContain("not enforced");
  });

  it("never applies the budget under none, even on a driver that answers it", async () => {
    const daemon = await DockerEngineEmulator.start({
      storageDriver: "overlay2",
      backingFilesystem: "xfs",
    });
    running.push(daemon);

    const provider = providerOver(daemon, { diskQuota: "none" });
    await provider.ensure(computer);

    expect(createBodies(daemon)[0]?.HostConfig?.["StorageOpt"]).toBeUndefined();
    await expect(provider.diskQuota()).resolves.toMatchObject({
      mode: "none",
      applied: false,
      enforced: false,
    });
  });

  it("fails closed under storage-opt on a driver that cannot answer the quota", async () => {
    const daemon = await DockerEngineEmulator.start({ storageDriver: "vfs" });
    running.push(daemon);

    const provider = providerOver(daemon, { diskQuota: "storage-opt" });

    // The create carries the quota and the daemon refuses it, rather than the
    // budget being silently dropped. The refusal is an operator-visible
    // protocol error because the mode asked for a guarantee the host cannot
    // keep.
    await expect(provider.ensure(computer)).rejects.toThrow(/storage-opt/);
    expect(createBodies(daemon)[0]?.HostConfig?.["StorageOpt"]).toEqual({
      size: `${String(DEFAULT_COMPUTER_CEILINGS.diskMb)}M`,
    });
  });

  it("rejects an unusable per-bot ceiling as a caller bug", async () => {
    const daemon = await emulator();

    expect(() => providerOver(daemon, { ceilings: { cpus: 0 } })).toThrow(RangeError);
    expect(() =>
      providerOver(daemon, { ceilings: { logConfig: { maxSize: "abc", maxFile: "3" } } }),
    ).toThrow(RangeError);
    expect(() =>
      providerOver(daemon, { ceilings: { logConfig: { maxSize: "10m", maxFile: "0" } } }),
    ).toThrow(RangeError);
  });
});

describe("the Docker computer provider snapshot and restore", () => {
  it("snapshots the home and restores it over a machine whose home moved on", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);
    daemon.writeFile("/home/agent/keep.txt", "kept");
    daemon.writeFile("/home/agent/notes/todo.txt", "buy milk");

    const snapshot = await provider.snapshot(computer);

    expect(snapshot.snapshotId.trim()).not.toBe("");
    expect(snapshot.key).toMatch(/^computer-snapshots\/[0-9a-f]{16}\/[0-9a-f-]{36}\.tar$/);

    // The volume moves on after the snapshot; the restore must bring back the
    // snapshot's bytes, not whatever the surviving volume holds.
    daemon.writeFile("/home/agent/keep.txt", "changed after the snapshot");
    await provider.destroy(computer);

    const restored = await provider.restore(computer, snapshot);

    expect(restored.state).toBe("running");
    const volume = [...daemon.volumes().values()].at(-1);
    expect(volume?.get("/home/agent/keep.txt")).toBe("kept");
    expect(volume?.get("/home/agent/notes/todo.txt")).toBe("buy milk");
  });

  it("refuses a snapshot key that names another computer's scope", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);
    const snapshot = await provider.snapshot(computer);

    const foreign = snapshot.key.replace(
      /^computer-snapshots\/[0-9a-f]{16}\//,
      "computer-snapshots/ffffffffffffffff/",
    );
    const failure = await failureFrom(provider.restore(computer, { ...snapshot, key: foreign }));

    expect(failure.kind).toBe("not_found");
  });
});

describe("the Docker computer provider exec", () => {
  it("reports stdout, stderr and the exit code from the daemon's framed stream", async () => {
    const daemon = await emulator();
    daemon.scriptExec("printf 'hello'", { exitCode: 0, stdout: "hello" });
    daemon.scriptExec("boom", { exitCode: 3, stderr: "boom\n" });
    const provider = providerOver(daemon);
    await provider.ensure(computer);

    await expect(
      provider.exec({ computer, command: "printf 'hello'", timeoutMs: 1_000 }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "hello",
      stderr: "",
    });
    await expect(
      provider.exec({ computer, command: "boom", timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      exitCode: 3,
      stderr: "boom\n",
    });
  });

  it("runs the command under a hard timeout and classifies its firing as timed_out", async () => {
    const daemon = await emulator();
    daemon.scriptExec("sleep 5", { exitCode: 124, stderr: "killed" });
    const provider = providerOver(daemon);
    await provider.ensure(computer);

    const failure = await failureFrom(
      provider.exec({ computer, command: "sleep 5", timeoutMs: 150 }),
    );

    expect(failure.kind).toBe("timed_out");
    const command = execCommand(daemon);

    expect(command.slice(0, 2)).toEqual(["timeout", "-k"]);
    expect(command).toContain("/bin/sh");
    expect(command.at(-1)).toBe("sleep 5");
  });
});
