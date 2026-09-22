import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerProvider, ComputerRef } from "@porkbot/adapter-kit";
import {
  computerConformance,
  CONFORMANCE_HOME,
  createDockerComputerProvider,
  LocalStorageProvider,
} from "@porkbot/adapters";
import type { ComputerConformanceHarness } from "@porkbot/adapters";
import { planComputerNetwork } from "@porkbot/core";
import { findRepoRoot } from "@porkbot/testkit";
import { afterAll, describe, expect, it } from "vitest";
import { createComputerLifecycle } from "../../src/computer-lifecycle.ts";
import { docker, dockerOrThrow, dockerQuietly } from "./docker.ts";

/**
 * The Docker provider against the real daemon (slice 7.2 acceptance).
 *
 * The offline suite in `@porkbot/adapters` drives the provider through a fake
 * Engine API; this spec runs the shared conformance suite against a real
 * container, and then pins what only the real thing can show: the ceilings are
 * on the container the daemon created, a reset gives a clean machine with the
 * home volume intact, and the idle sweep parks a machine with its home kept.
 *
 * CI starts the local stack first, which builds the images and pulls the
 * pinned node image from `dependencies.json`, so the suite can assert instead
 * of skipping. Everything is suffixed, and the cleanup removes the containers,
 * volumes and networks this file created — and nothing else.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const register = JSON.parse(readFileSync(path.join(repoRoot, "dependencies.json"), "utf8")) as {
  images: { name: string; reference: string }[];
};
const nodeImage = register.images.find((image) => image.name === "node")?.reference;

if (nodeImage === undefined) {
  throw new Error("dependencies.json registers no node image for the Docker computer suite");
}

const suffix = Math.random().toString(36).slice(2, 8);
const created: ComputerRef[] = [];

function endpoint():
  { readonly socketPath: string } | { readonly host: string; readonly port: number } {
  const dockerHost = process.env["DOCKER_HOST"]?.trim();

  if (dockerHost === undefined || dockerHost === "" || dockerHost.startsWith("unix://")) {
    return {
      socketPath:
        dockerHost === undefined || dockerHost === ""
          ? "/var/run/docker.sock"
          : dockerHost.slice("unix://".length),
    };
  }

  const url = new URL(dockerHost);
  const port = Number(url.port === "" ? "2375" : url.port);

  return { host: url.hostname, port: Number.isFinite(port) ? port : 2375 };
}

let storageRoot: string | undefined;
let scratchDirectory: string | undefined;
let provider: ComputerProvider | undefined;
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));

  temporaryDirectories.push(directory);
  return directory;
}

async function providerUnderTest(): Promise<ComputerProvider> {
  if (provider !== undefined) {
    return provider;
  }

  storageRoot ??= await makeTemporaryDirectory("porkbot-docker-storage-");
  scratchDirectory ??= await makeTemporaryDirectory("porkbot-docker-archives-");
  provider = createDockerComputerProvider({
    image: nodeImage,
    ...endpoint(),
    storage: new LocalStorageProvider({ root: storageRoot }),
    scratchDirectory,
    bootTimeoutMs: 30_000,
    archiveTimeoutMs: 60_000,
  });
  return provider;
}

let counter = 0;

async function createHarness(): Promise<ComputerConformanceHarness> {
  counter += 1;
  const computer = {
    computerId: `dockersuite-computer-${suffix}-${counter}`,
    botId: `dockersuite-bot-${suffix}`,
  };
  const otherComputer = {
    computerId: `dockersuite-computer-${suffix}-${counter}-b`,
    botId: `dockersuite-bot-${suffix}`,
  };

  created.push(computer, otherComputer);

  return {
    provider: await providerUnderTest(),
    computer,
    otherComputer,
    home: CONFORMANCE_HOME,
    timeoutMs: 1_000,
    slowCommand: "sleep 5",
  };
}

await computerConformance("createDockerComputerProvider", createHarness);

function containerIdFor(computer: ComputerRef): string | undefined {
  const id = dockerOrThrow([
    "ps",
    "-aq",
    "--filter",
    `label=porkbot.computer.id=${computer.computerId}`,
  ]).trim();

  return id === "" ? undefined : id;
}

function inspectHostConfig(containerId: string): Record<string, unknown> {
  const [inspection] = JSON.parse(dockerOrThrow(["inspect", containerId])) as {
    HostConfig?: Record<string, unknown>;
  }[];

  if (inspection?.HostConfig === undefined) {
    throw new Error("docker inspect returned no HostConfig");
  }

  return inspection.HostConfig;
}

function logPathFor(containerId: string): string | undefined {
  const [inspection] = JSON.parse(dockerOrThrow(["inspect", containerId])) as {
    LogPath?: string;
  }[];

  return inspection?.LogPath;
}

function totalLogBytes(logPath: string): { bytes: number; files: number } {
  const directory = path.dirname(logPath);
  const basename = path.basename(logPath);
  const entries = readdirSync(directory).filter((entry) => entry === basename || entry.startsWith(`${basename}.`));
  let bytes = 0;

  for (const entry of entries) {
    bytes += statSync(path.join(directory, entry)).size;
  }

  return { bytes, files: entries.length };
}

afterAll(async () => {
  const active = await providerUnderTest();

  for (const computer of created) {
    // Collect the volume before the container goes, then remove both.
    const containerId = containerIdFor(computer);
    const volumeName =
      containerId === undefined
        ? undefined
        : (
            JSON.parse(dockerOrThrow(["inspect", containerId])) as {
              Mounts?: { Name?: string }[];
            }[]
          )[0]?.Mounts?.find((mount) => mount.Name?.startsWith("porkbot-home-"))?.Name;

    await active.destroy(computer).catch(() => undefined);

    if (volumeName !== undefined) {
      dockerQuietly(["volume", "rm", "-f", volumeName]);
    }

    dockerQuietly(["network", "rm", planComputerNetwork(computer).name]);
  }

  await Promise.all(
    temporaryDirectories.map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("the Docker provider against the real daemon", () => {
  it("puts the configured ceilings on the container the daemon created", async () => {
    const daemonProvider = createDockerComputerProvider({
      image: nodeImage,
      ...endpoint(),
      storage: new LocalStorageProvider({
        root: await makeTemporaryDirectory("porkbot-docker-ceilings-storage-"),
      }),
      scratchDirectory: await makeTemporaryDirectory("porkbot-docker-ceilings-archives-"),
      ceilings: { cpus: 0.5, memoryMb: 256, pids: 32 },
    });
    const computer = {
      computerId: `dockersuite-ceilings-${suffix}`,
      botId: `dockersuite-bot-${suffix}`,
    };
    created.push(computer);

    try {
      await daemonProvider.ensure(computer);
      const containerId = containerIdFor(computer);

      expect(containerId).toBeDefined();
      const hostConfig = inspectHostConfig(containerId ?? "");

      expect(hostConfig["NanoCpus"]).toBe(500_000_000);
      expect(hostConfig["Memory"]).toBe(256 * 1024 * 1024);
      expect(hostConfig["MemorySwap"]).toBe(256 * 1024 * 1024);
      expect(hostConfig["PidsLimit"]).toBe(32);
      expect(hostConfig["Init"]).toBe(true);
      expect(hostConfig["LogConfig"]).toEqual({
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      });
      expect(hostConfig["NetworkMode"]).toBe(planComputerNetwork(computer).name);
      expect(hostConfig["Binds"]).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^porkbot-home-[0-9a-f]{16}:\/home\/agent$/),
        ]),
      );
    } finally {
      await daemonProvider.destroy(computer).catch(() => undefined);
    }
  });

  it("stops a chatty machine's log file from growing past the rotation cap", async () => {
    const logConfig = { maxSize: "1k", maxFile: "2" };
    const daemonProvider = createDockerComputerProvider({
      image: nodeImage,
      ...endpoint(),
      storage: new LocalStorageProvider({
        root: await makeTemporaryDirectory("porkbot-docker-logcap-storage-"),
      }),
      scratchDirectory: await makeTemporaryDirectory("porkbot-docker-logcap-archives-"),
      ceilings: { logConfig },
    });
    const computer = {
      computerId: `dockersuite-logcap-${suffix}`,
      botId: `dockersuite-bot-${suffix}`,
    };
    created.push(computer);

    try {
      await daemonProvider.ensure(computer);
      const containerId = containerIdFor(computer);

      expect(containerId).toBeDefined();
      const hostConfig = inspectHostConfig(containerId ?? "");

      expect(hostConfig["LogConfig"]).toEqual({
        Type: "json-file",
        Config: { "max-size": logConfig.maxSize, "max-file": logConfig.maxFile },
      });

      // Flood the container's stdout — the main process's fd, not exec's own
      // output — with far more text than the cap allows, then let the daemon
      // flush and rotate.
      dockerOrThrow([
        "exec",
        containerId ?? "",
        "sh",
        "-c",
        "for i in $(seq 1 500); do echo \"chatty line $i padding padding padding padding padding padding padding padding padding padding\"; done > /proc/1/fd/1",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const logPath = logPathFor(containerId ?? "");

      expect(logPath).toBeDefined();
      const { bytes, files } = totalLogBytes(logPath ?? "");
      const maxFiles = Number(logConfig.maxFile);

      // max-file counts the current file plus its rotations. The daemon may
      // slightly overshoot max-size at a write boundary, but the total stays
      // near max-size × max-file — not the 50 kB the machine just wrote.
      expect(files).toBeLessThanOrEqual(maxFiles);
      expect(bytes).toBeLessThan(50_000);
    } finally {
      await daemonProvider.destroy(computer).catch(() => undefined);
    }
  });

  it("removes the computer's isolated network on destroy", async () => {
    const daemonProvider = await providerUnderTest();
    const computer = {
      computerId: `dockersuite-network-${suffix}`,
      botId: `dockersuite-bot-${suffix}`,
    };
    const network = planComputerNetwork(computer).name;

    created.push(computer);

    try {
      await daemonProvider.ensure(computer);

      expect(dockerOrThrow(["network", "inspect", network])).toContain(network);

      await daemonProvider.destroy(computer);

      // The daemon's subnet pools are finite; a network that outlived its
      // computer would eventually refuse the next boot.
      expect(docker(["network", "inspect", network]).status).not.toBe(0);
    } finally {
      await daemonProvider.destroy(computer).catch(() => undefined);
      dockerQuietly(["network", "rm", network]);
    }
  });

  it("restores over a running machine without losing the isolation boundary", async () => {
    const daemonProvider = await providerUnderTest();
    const computer = {
      computerId: `dockersuite-restore-${suffix}`,
      botId: `dockersuite-bot-${suffix}`,
    };

    created.push(computer);

    try {
      await daemonProvider.ensure(computer);
      await daemonProvider.exec({
        computer,
        command: "printf 'kept' > /home/agent/kept.txt",
        timeoutMs: 60_000,
      });
      const snapshot = await daemonProvider.snapshot(computer);

      // Restore replaces the running machine; the provider removes it (and
      // with it the network) before the replacement is created, so the
      // boundary has to be planned again or the replacement cannot attach.
      const restored = await daemonProvider.restore(computer, snapshot);

      expect(restored.state).toBe("running");
      const kept = await daemonProvider.exec({
        computer,
        command: "cat /home/agent/kept.txt",
        timeoutMs: 60_000,
      });

      expect(kept.stdout).toBe("kept");
      expect(dockerOrThrow(["network", "inspect", planComputerNetwork(computer).name])).toContain(
        planComputerNetwork(computer).name,
      );
    } finally {
      await daemonProvider.destroy(computer).catch(() => undefined);
    }
  });

  it("resets to a clean machine without deleting the agent home", async () => {
    const daemonProvider = await providerUnderTest();
    const computer = {
      computerId: `dockersuite-reset-${suffix}`,
      botId: `dockersuite-bot-${suffix}`,
    };
    created.push(computer);

    await daemonProvider.ensure(computer);
    await daemonProvider.exec({
      computer,
      command: "printf 'kept' > /home/agent/kept.txt && printf 'scratch' > /tmp/scratch.txt",
      timeoutMs: 60_000,
    });

    // Reset is destroy plus ensure: the container is rebuilt clean, the home
    // volume is what survives.
    await daemonProvider.destroy(computer);
    await daemonProvider.ensure(computer);

    const kept = await daemonProvider.exec({
      computer,
      command: "cat /home/agent/kept.txt",
      timeoutMs: 60_000,
    });

    expect(kept.stdout).toBe("kept");

    const scratch = await daemonProvider.exec({
      computer,
      command: "cat /tmp/scratch.txt",
      timeoutMs: 60_000,
    });

    expect(scratch.exitCode).not.toBe(0);
  });

  it("parks an idle machine through the lifecycle and keeps its home", async () => {
    const daemonProvider = await providerUnderTest();
    const computer = {
      computerId: `dockersuite-idle-${suffix}`,
      botId: `dockersuite-bot-${suffix}`,
    };
    created.push(computer);
    const lifecycle = createComputerLifecycle({ provider: daemonProvider, idleTimeoutMs: 1 });

    await lifecycle.boot(computer);
    await lifecycle.exec({
      computer,
      command: "printf 'kept' > /home/agent/idle.txt",
      timeoutMs: 60_000,
    });

    // The window is one millisecond, so the sweep sees the machine as idle.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const report = await lifecycle.stopIdle();

    expect(report.stopped).toEqual(
      expect.arrayContaining([expect.objectContaining({ computerId: computer.computerId })]),
    );
    await expect(lifecycle.status(computer)).resolves.toMatchObject({ state: "stopped" });

    await lifecycle.boot(computer);
    const kept = await lifecycle.exec({
      computer,
      command: "cat /home/agent/idle.txt",
      timeoutMs: 60_000,
    });

    expect(kept.stdout).toBe("kept");
  });
});
