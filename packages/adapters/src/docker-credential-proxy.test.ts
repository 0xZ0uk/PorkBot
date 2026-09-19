import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProviderFailure } from "@porkbot/adapter-kit";
import type {
  ComputerProvider,
  ComputerProxyGrant,
  ComputerRef,
  ProviderFailure,
} from "@porkbot/adapter-kit";
import { planComputerNetwork } from "@porkbot/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDockerComputerProvider,
  DOCKER_PROXY_GRANT_DIR,
  dockerComputerName,
  dockerProxyName,
} from "./docker-computer.ts";
import { DockerEngineEmulator } from "./docker-engine-emulator.ts";
import { LocalStorageProvider } from "./local-storage.ts";

/**
 * The Docker credential-proxy sidecar (slice 7.8, PRD decision 29).
 *
 * The provider is driven through the Engine API emulator, so these are the
 * real requests the provider sends a daemon: the sidecar's second network, the
 * grant archive written into its own layer, the per-command environment, and the
 * tombstone a revoke leaves. The acceptance check the slice exists for is here
 * too — a grep of everything the sandbox can read — because the emulator
 * models the computer's and the sidecar's filesystems separately, which is the
 * boundary being asserted.
 */

const image = "porkbot-test-computer:1";
const proxyImage = "porkbot-test-proxy:1";
const egressNetwork = "porkbot-egress";
const tokenSecret = "docker-proxy-test-secret";
const marker = "sk-docker-marker";
const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };

const running: DockerEngineEmulator[] = [];
const directories: string[] = [];

async function emulator(): Promise<DockerEngineEmulator> {
  const started = await DockerEngineEmulator.start();
  running.push(started);
  started.addNetwork(egressNetwork);
  return started;
}

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function providerOver(
  daemon: DockerEngineEmulator,
  overrides: Partial<Parameters<typeof createDockerComputerProvider>[0]> = {},
): ComputerProvider {
  return createDockerComputerProvider({
    image,
    socketPath: daemon.socketPath,
    storage: new LocalStorageProvider({ root: tempDirectory("porkbot-docker-storage-") }),
    scratchDirectory: tempDirectory("porkbot-docker-archives-"),
    proxy: { image: proxyImage, tokenSecret, egressNetwork },
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (instance) => instance.stop()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createBodies(daemon: DockerEngineEmulator): readonly Record<string, unknown>[] {
  return daemon.requests
    .filter((entry) => entry.method === "POST" && entry.path.startsWith("/containers/create"))
    .map((entry) => entry.body as Record<string, unknown>);
}

function proxyBody(daemon: DockerEngineEmulator): Record<string, unknown> | undefined {
  return createBodies(daemon).find((body) => {
    const labels = body["Labels"];

    return typeof labels === "object" && labels !== null && "porkbot.proxy.for" in labels;
  });
}

function sandboxBody(daemon: DockerEngineEmulator): Record<string, unknown> | undefined {
  return createBodies(daemon).find((body) => {
    const labels = body["Labels"];

    return typeof labels === "object" && labels !== null && "porkbot.computer.id" in labels;
  });
}

function grant(runId = "run-1"): ComputerProxyGrant {
  return {
    runId,
    expiresAtSeconds: Math.floor(Date.now() / 1_000) + 3_600,
    upstreams: [
      {
        name: "model",
        origin: "https://api.model.example",
        headers: { authorization: `Bearer ${marker}` },
      },
    ],
  };
}

describe("the Docker credential-proxy sidecar", () => {
  it("declares a readiness probe so `ready` means the proxy answers, not merely exists", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);

    await provider.ensure(computer);

    const healthcheck = proxyBody(daemon)?.["Healthcheck"] as
      { readonly Test?: readonly string[]; readonly Retries?: number } | undefined;

    expect(healthcheck?.Test?.[0]).toBe("CMD");
    // The probe is a TCP connect to the proxy's port: it answers "is the
    // server listening", which is the readiness question a grant depends on.
    expect(healthcheck?.Test?.join(" ")).toContain("net.connect");
    expect(healthcheck?.Test?.join(" ")).toContain("8321");
  });

  it("places the sidecar on the machine's isolated network and the egress network", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);

    await provider.ensure(computer);

    const proxy = proxyBody(daemon);

    expect(proxy).toBeDefined();
    expect(proxy?.["Image"]).toBe(proxyImage);
    expect(daemon.attachmentsOf(dockerProxyName(computer))).toEqual(
      expect.arrayContaining([planComputerNetwork(computer).name, egressNetwork]),
    );
    expect(daemon.attachmentsOf(dockerComputerName(computer))).toEqual([
      planComputerNetwork(computer).name,
    ]);
  });

  it("writes a grant onto the sidecar's own layer and keeps it out of the sandbox entirely", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);

    const endpoint = await provider.proxy?.grant(computer, grant());

    expect(endpoint?.url).toMatch(/^http:\/\/porkbot-proxy-[0-9a-f]+:8321$/);

    const sidecarFiles = daemon.filesOf(dockerProxyName(computer));
    const stored = sidecarFiles.get(path.posix.join(DOCKER_PROXY_GRANT_DIR, "run-1.json"));

    expect(stored).toContain(marker);
    expect(stored).toContain("api.model.example");

    // The layer is the sidecar's; the sandbox's own filesystem never sees the
    // grant, its directory or the credential. This is the grep the acceptance
    // criterion asks for, over both filesystems the emulator models.
    expect([...daemon.filesOf(dockerComputerName(computer)).keys()]).not.toContain(
      path.posix.join(DOCKER_PROXY_GRANT_DIR, "run-1.json"),
    );

    for (const file of daemon.filesOf(dockerComputerName(computer)).values()) {
      expect(file).not.toContain(marker);
    }

    // The sidecar is a sidecar: no bind and no shared volume, so the grant
    // rests on its own layer and a stop or a destroy takes it along.
    expect(proxyBody(daemon)?.["HostConfig"]).not.toHaveProperty("Binds");

    // Nothing that created the sandbox carried the credential: the grant
    // crossed exactly once, through the archive write into the sidecar.
    for (const body of createBodies(daemon)) {
      expect(JSON.stringify(body)).not.toContain(marker);
    }

    // Every request the emulator can read as JSON is checked for the marker:
    // the container create, the exec and every other call carried none of it.
    // (The archive body is a tar the emulator records as a byte count, so its
    // content is asserted against the sidecar's own filesystem above; the
    // real daemon's wire is covered by the integration suite.)
    expect(
      daemon.requests.filter((entry) => JSON.stringify(entry.body ?? "").includes(marker)),
    ).toEqual([]);
  });

  it("passes a per-command capability environment and no credential to an exec", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);
    const endpoint = await provider.proxy?.grant(computer, grant());

    await provider.exec({
      computer,
      command: "printenv",
      timeoutMs: 5_000,
      environment: {
        PORKBOT_PROXY_URL: endpoint?.url ?? "",
        PORKBOT_PROXY_TOKEN: "capability-token",
      },
    });

    const exec = daemon.requests.find(
      (entry) => entry.method === "POST" && entry.path.includes("/exec"),
    );
    const env = (exec?.body as { readonly Env?: readonly string[] } | undefined)?.Env ?? [];

    expect(env).toEqual([
      `PORKBOT_PROXY_URL=${endpoint?.url ?? ""}`,
      "PORKBOT_PROXY_TOKEN=capability-token",
    ]);
    expect(JSON.stringify(env)).not.toContain(marker);

    // Nothing that created the sandbox — the container, the exec — carried the
    // credential; only the archive into the sidecar did.
    for (const body of createBodies(daemon)) {
      expect(JSON.stringify(body)).not.toContain(marker);
    }
  });

  it("revokes by writing a tombstone the proxy reads as no grant", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);
    await provider.proxy?.grant(computer, grant());

    await provider.proxy?.revoke(computer, "run-1");

    const stored = daemon
      .filesOf(dockerProxyName(computer))
      .get(path.posix.join(DOCKER_PROXY_GRANT_DIR, "run-1.json"));

    expect(JSON.parse(stored ?? "{}")).toEqual({
      runId: "run-1",
      expiresAtSeconds: 1,
      upstreams: [],
    });
  });

  it("refuses a grant until the proxy is running and answers absent when it is parked", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);

    await expect(provider.proxy?.endpoint(computer)).resolves.toBeUndefined();

    await provider.ensure(computer);
    await expect(provider.proxy?.endpoint(computer)).resolves.toEqual({
      url: expect.stringMatching(/^http:\/\/porkbot-proxy-[0-9a-f]+:8321$/),
    });

    await provider.stop(computer);

    await expect(provider.proxy?.endpoint(computer)).resolves.toBeUndefined();

    try {
      await provider.proxy?.grant(computer, grant());
      throw new Error("expected the grant to be refused");
    } catch (error) {
      expect(isProviderFailure(error)).toBe(true);
      expect((error as ProviderFailure).kind).toBe("gone");
    }

    // A revoked parked proxy is already gone: the call is a quiet no-op.
    await expect(provider.proxy?.revoke(computer, "run-1")).resolves.toBeUndefined();
  });

  it("does not pull a sidecar image for a provider configured without a proxy", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon, { proxy: undefined });

    expect(provider.proxy).toBeUndefined();

    await provider.ensure(computer);

    expect(proxyBody(daemon)).toBeUndefined();
    expect(daemon.imageNames).not.toContain(proxyImage);
  });

  it("keeps the sidecar's configuration out of the sandbox and the sandbox out of the sidecar's", async () => {
    const daemon = await emulator();
    const provider = providerOver(daemon);
    await provider.ensure(computer);

    const sidecarEnv = (proxyBody(daemon)?.["Env"] ?? []) as readonly string[];
    const sandboxEnv = (sandboxBody(daemon)?.["Env"] ?? []) as readonly string[];

    expect(sidecarEnv).toEqual(
      expect.arrayContaining([
        `PORKBOT_PROXY_TOKEN_SECRET=${tokenSecret}`,
        `PORKBOT_PROXY_COMPUTER_ID=${computer.computerId}`,
        `PORKBOT_PROXY_GRANT_DIR=${DOCKER_PROXY_GRANT_DIR}`,
      ]),
    );
    expect(sandboxEnv).toHaveLength(0);
    expect(JSON.stringify(sandboxBody(daemon))).not.toContain(tokenSecret);
  });
});
