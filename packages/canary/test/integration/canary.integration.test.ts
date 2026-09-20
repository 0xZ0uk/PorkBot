import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerProvider, ComputerRef } from "@porkbot/adapter-kit";
import { createDockerComputerProvider, LocalStorageProvider } from "@porkbot/adapters";
import { findRepoRoot } from "@porkbot/testkit";
import { afterAll, describe, expect, it } from "vitest";
import { CANARY_BOT_ID } from "../../src/policy.ts";
import { runCanary } from "../../src/runner.ts";

/**
 * The canary runner against the real daemon (slice 12.6 acceptance).
 *
 * The unit suite drives the runner against the offline emulator; this spec
 * drives it through the same provider the supervisor constructs, against a real
 * container built from the digest `dependencies.json` pins. It is what makes
 * "the nightly canary hits real Docker" a claim CI checks on every pull
 * request rather than one the nightly workflow alone would prove.
 *
 * CI starts the local stack first, which builds the images and pulls the pinned
 * node image, so the suite asserts instead of skipping. Everything the spec
 * creates is suffixed and destroyed; the cleanup is a backstop, not the proof.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const register = JSON.parse(readFileSync(path.join(repoRoot, "dependencies.json"), "utf8")) as {
  images: { name: string; reference: string }[];
};
const nodeImage = register.images.find((image) => image.name === "node")?.reference;

if (nodeImage === undefined) {
  throw new Error("dependencies.json registers no node image for the canary suite");
}

const computerImage: string = nodeImage;

const suffix = Math.random().toString(36).slice(2, 8);
const temporaryDirectories: string[] = [];
let provider: ComputerProvider | undefined;

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

async function providerUnderTest(): Promise<ComputerProvider> {
  if (provider !== undefined) {
    return provider;
  }

  const storageRoot = await mkdtemp(path.join(tmpdir(), "porkbot-canary-storage-"));
  const scratchDirectory = await mkdtemp(path.join(tmpdir(), "porkbot-canary-archives-"));

  temporaryDirectories.push(storageRoot, scratchDirectory);
  provider = createDockerComputerProvider({
    image: computerImage,
    ...endpoint(),
    storage: new LocalStorageProvider({ root: storageRoot }),
    scratchDirectory,
    bootTimeoutMs: 30_000,
    archiveTimeoutMs: 60_000,
  });

  return provider;
}

afterAll(async () => {
  const active = provider;

  if (active !== undefined) {
    const held = await active.list().catch(() => []);

    for (const status of held) {
      await active.destroy(status.computer).catch(() => undefined);
    }
  }

  await Promise.all(
    temporaryDirectories.map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("the canary against the real daemon", () => {
  it("boots, runs, makes the tool call and verifies the teardown", async () => {
    const docker = await providerUnderTest();
    const report = await runCanary({
      provider: docker,
      kind: "docker",
      runId: `canary-docker-${suffix}-ok`,
    });

    expect(report.status).toBe("succeeded");
    expect(report.teardownVerified).toBe(true);
    expect(report.failure).toBeUndefined();

    // The daemon is shared with the other integration suites, so the assertion
    // is about the canary's own machines rather than about the daemon being
    // empty: nothing may carry the canary bot id.
    const remaining = (await docker.list()).filter(
      (status) => status.computer.botId === CANARY_BOT_ID,
    );

    expect(remaining).toEqual([]);
  });

  it("sweeps a machine a previous run left behind before it runs", async () => {
    const docker = await providerUnderTest();
    const leftover: ComputerRef = {
      computerId: `canary-docker-${suffix}-leftover`,
      botId: CANARY_BOT_ID,
    };

    await docker.ensure(leftover);

    const report = await runCanary({
      provider: docker,
      kind: "docker",
      runId: `canary-docker-${suffix}-sweep`,
    });

    expect(report.status).toBe("succeeded");
    expect(report.orphansRemoved).toBe(1);
    const remaining = await docker.list();

    expect(remaining.some((status) => status.computer.computerId === leftover.computerId)).toBe(
      false,
    );
  });
});
