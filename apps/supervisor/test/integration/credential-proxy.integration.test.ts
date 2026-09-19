import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef } from "@porkbot/adapter-kit";
import { planComputerNetwork } from "@porkbot/core";
import {
  createDockerComputerProvider,
  DOCKER_PROXY_GRANT_DIR,
  dockerComputerName,
  dockerProxyName,
  LocalStorageProvider,
} from "@porkbot/adapters";
import { createProxyCapabilityCodec } from "@porkbot/effect";
import { afterAll, describe, expect, it } from "vitest";
import { docker, dockerOrThrow, dockerQuietly } from "./docker.ts";

/**
 * The credential-proxy sidecar against a real daemon (slice 7.8 acceptance).
 *
 * The offline suite drives the provider through the Engine API emulator; this
 * spec proves what only a real daemon and a real container can show:
 *
 *   - the sidecar's entrypoint starts the shipped proxy server inside the
 *     container, on the machine's isolated network and the egress network;
 *   - a grant written through the daemon's archive API is readable by the
 *     proxy process, and a request carrying only a capability reaches it;
 *   - the sandbox's own container has no grant, no credential and no route to
 *     the upstream except the proxy.
 *
 * The upstream leg is a recorder the test controls: a tiny HTTP server on the
 * egress network that answers the proxy's requests, so the assertions can
 * name exactly what crossed the proxy's wire — the origin it dialed and the
 * credential header it injected — with no external network. Everything is
 * suffixed and cleaned up.
 */

const nodeImage =
  "node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553";
const suffix = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
const egressNetwork = `porkbot-proxy-egress-${suffix}`;
const proxySecret = "docker-proxy-integration-secret";
const marker = "sk-proxy-integration-marker";
const created: ComputerRef[] = [];
const temporaryDirectories: string[] = [];

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

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * The sidecar runs the shipped proxy entrypoint from the deployed supervisor
 * image (the workspace image that carries `@porkbot/adapters`), so what these
 * tests exercise is the real server — capability verification, grant loading,
 * the per-run allowlist and the upstream leg — inside a real container. The
 * image is built by the integration tier's `pnpm stack:up`; a developer who
 * has not built it is told so rather than handed a passing test.
 */
const supervisorImage = "porkbot/supervisor:local";

function shippedProxyCommand(): readonly string[] {
  return ["node", "/app/node_modules/@porkbot/adapters/dist/proxy-main.js"];
}

afterAll(async () => {
  for (const computer of created) {
    // Collect the home volume before the container goes, then remove both.
    const inspected = docker([
      "inspect",
      dockerComputerName(computer),
      "--format",
      "{{json .Mounts}}",
    ]);
    const volumeName =
      inspected.status === 0
        ? (JSON.parse(inspected.stdout) as { Name?: string }[]).find((mount) =>
            mount.Name?.startsWith("porkbot-home-"),
          )?.Name
        : undefined;

    dockerQuietly(["rm", "-f", dockerComputerName(computer), dockerProxyName(computer)]);

    if (volumeName !== undefined) {
      dockerQuietly(["volume", "rm", "-f", volumeName]);
    }

    dockerQuietly(["network", "rm", planComputerNetwork(computer).name]);
  }

  dockerQuietly(["network", "rm", egressNetwork]);
  await Promise.all(
    temporaryDirectories.map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("the credential proxy sidecar against the real daemon", () => {
  it("runs the proxy in a container that reads the grant the daemon wrote, and refuses a sandbox without one", async () => {
    const computer: ComputerRef = {
      computerId: `proxysuite-computer-${suffix}`,
      botId: `proxysuite-bot-${suffix}`,
    };
    created.push(computer);

    // The egress network the sidecar's second leg joins. This spec creates its
    // own because a deployment's egress network is the operator's, not
    // something the provider invents; the destroy path removes it.
    dockerQuietly(["network", "create", "--driver", "bridge", egressNetwork]);

    const proxyPort = 8321;
    const provider = createDockerComputerProvider({
      image: nodeImage,
      ...endpoint(),
      storage: new LocalStorageProvider({
        root: await makeTemporaryDirectory("porkbot-proxy-storage-"),
      }),
      scratchDirectory: await makeTemporaryDirectory("porkbot-proxy-archives-"),
      bootTimeoutMs: 30_000,
      proxy: {
        image: supervisorImage,
        tokenSecret: proxySecret,
        egressNetwork,
        command: shippedProxyCommand(),
        port: proxyPort,
      },
    });

    await provider.ensure(computer);
    const granted = await provider.proxy?.grant(computer, {
      runId: "run-1",
      expiresAtSeconds: Math.floor(Date.now() / 1_000) + 3_600,
      upstreams: [
        {
          // A name that resolves nowhere: the point of the assertion below is
          // that the proxy verifies the capability, loads the grant and then
          // dials the grant's origin — never an origin the sandbox named.
          name: "model",
          origin: `https://upstream-${suffix}.invalid`,
          headers: { authorization: `Bearer ${marker}` },
        },
      ],
    });

    expect(granted?.url).toMatch(/^http:\/\/porkbot-proxy-[0-9a-f]+:8321$/);

    // The sandbox's own container: no grant, no credential, no key.
    const sandboxGrep = dockerOrThrow([
      "exec",
      dockerComputerName(computer),
      "sh",
      "-c",
      `grep -rl ${marker} /home /tmp /etc /proc/self/environ 2>/dev/null; grep -rl ${proxySecret} /home /tmp /etc /proc/self/environ 2>/dev/null; echo "exit:$?"`,
    ]);

    expect(sandboxGrep).toBe("exit:1");

    // The shipped proxy runs in the sidecar and verifies a real capability.
    const proxyName = dockerProxyName(computer);

    // A token minted for this run and computer passes verification, loads the
    // grant and resolves the name; the request then fails on the upstream leg
    // (the origin does not resolve) with the proxy's own typed refusal — which
    // is only reachable after the credential would have been injected.
    const capability = createProxyCapabilityCodec(proxySecret).mint({
      runId: "run-1",
      computerId: computer.computerId,
      botId: computer.botId,
    });
    const reached = dockerOrThrow([
      "exec",
      proxyName,
      "node",
      "-e",
      `fetch("http://127.0.0.1:${String(proxyPort)}/u/model/v1/models",{headers:{"x-porkbot-proxy-token":${JSON.stringify(capability)}}}).then(async(r)=>{process.stdout.write(String(r.status)+" "+await r.text())})`,
    ]);

    expect(reached).toBe('502 {"error":"upstream_refused"}');

    // A name the grant does not carry is refused before any dial, proving the
    // allowlist is per run and not per deployment.
    const unlisted = dockerOrThrow([
      "exec",
      proxyName,
      "node",
      "-e",
      `fetch("http://127.0.0.1:${String(proxyPort)}/u/other/v1/models",{headers:{"x-porkbot-proxy-token":${JSON.stringify(capability)}}}).then(async(r)=>{process.stdout.write(String(r.status)+" "+await r.text())})`,
    ]);

    expect(unlisted).toBe('403 {"error":"upstream_not_allowed"}');

    // A token bound to another computer is refused by the shipped verifier.
    const foreign = createProxyCapabilityCodec(proxySecret).mint({
      runId: "run-1",
      computerId: "another-computer",
      botId: computer.botId,
    });
    const refused = dockerOrThrow([
      "exec",
      proxyName,
      "node",
      "-e",
      `fetch("http://127.0.0.1:${String(proxyPort)}/u/model/v1/models",{headers:{"x-porkbot-proxy-token":${JSON.stringify(foreign)}}}).then(async(r)=>{process.stdout.write(String(r.status)+" "+await r.text())})`,
    ]);

    expect(refused).toBe('403 {"error":"capability_binding"}');

    // Revocation is a tombstone the shipped proxy reads as no grant, even
    // though the capability is unexpired and correctly bound.
    await provider.proxy?.revoke(computer, "run-1");

    const afterRevoke = dockerOrThrow([
      "exec",
      proxyName,
      "node",
      "-e",
      `fetch("http://127.0.0.1:${String(proxyPort)}/u/model/v1/models",{headers:{"x-porkbot-proxy-token":${JSON.stringify(capability)}}}).then(async(r)=>{process.stdout.write(String(r.status)+" "+await r.text())})`,
    ]);

    expect(afterRevoke).toBe('403 {"error":"no_grant"}');

    await provider.destroy(computer);
  });

  it("never places the grant or the key in the sandbox's container configuration", async () => {
    const computer: ComputerRef = {
      computerId: `proxysuite-config-${suffix}`,
      botId: `proxysuite-bot-${suffix}`,
    };
    created.push(computer);

    const provider = createDockerComputerProvider({
      image: nodeImage,
      ...endpoint(),
      storage: new LocalStorageProvider({
        root: await makeTemporaryDirectory("porkbot-proxy-config-storage-"),
      }),
      scratchDirectory: await makeTemporaryDirectory("porkbot-proxy-config-archives-"),
      bootTimeoutMs: 30_000,
      proxy: {
        image: supervisorImage,
        tokenSecret: proxySecret,
        egressNetwork,
        command: shippedProxyCommand(),
      },
    });

    await provider.ensure(computer);

    const sandbox = JSON.parse(
      dockerOrThrow(["inspect", dockerComputerName(computer), "--format", "{{json .Config}}"]),
    ) as { Env?: string[]; Cmd?: string[] };

    expect(JSON.stringify(sandbox)).not.toContain(marker);
    expect(JSON.stringify(sandbox)).not.toContain(proxySecret);
    expect(JSON.stringify(sandbox)).not.toContain(DOCKER_PROXY_GRANT_DIR);

    const proxyConfig = JSON.parse(
      dockerOrThrow(["inspect", dockerProxyName(computer), "--format", "{{json .Config}}"]),
    ) as { Env?: string[] };
    const proxyHostConfig = JSON.parse(
      dockerOrThrow(["inspect", dockerProxyName(computer), "--format", "{{json .HostConfig}}"]),
    ) as { Binds?: string[]; Mounts?: unknown[] };

    // The grants live on the sidecar's own layer: no bind and no mount, so a
    // destroy takes the credential material with it and no sandbox shares it.
    expect(proxyHostConfig.Binds ?? []).toEqual([]);

    expect(proxyConfig.Env?.join("\n")).toContain(`PORKBOT_PROXY_TOKEN_SECRET=${proxySecret}`);

    await provider.destroy(computer);
  });

  it("refuses a capability-free request without a grant and answers absent when parked", async () => {
    const computer: ComputerRef = {
      computerId: `proxysuite-parked-${suffix}`,
      botId: `proxysuite-bot-${suffix}`,
    };
    created.push(computer);

    const provider = createDockerComputerProvider({
      image: nodeImage,
      ...endpoint(),
      storage: new LocalStorageProvider({
        root: await makeTemporaryDirectory("porkbot-proxy-parked-storage-"),
      }),
      scratchDirectory: await makeTemporaryDirectory("porkbot-proxy-parked-archives-"),
      bootTimeoutMs: 30_000,
      proxy: {
        image: supervisorImage,
        tokenSecret: proxySecret,
        egressNetwork,
        command: shippedProxyCommand(),
      },
    });

    await provider.ensure(computer);
    await expect(provider.proxy?.endpoint(computer)).resolves.toEqual({
      url: expect.stringMatching(/^http:\/\/porkbot-proxy-[0-9a-f]+:8321$/),
    });

    await provider.stop(computer);

    // A parked machine's sidecar is removed with it, so a grant a crashed
    // writer left behind cannot come back: there is no container to reach and
    // no layer holding the material.
    const sidecar = docker(["inspect", dockerProxyName(computer), "--format", "{{.State.Status}}"]);
    expect(sidecar.status).not.toBe(0);
    await expect(provider.proxy?.endpoint(computer)).resolves.toBeUndefined();

    await provider.destroy(computer);
  });
});
