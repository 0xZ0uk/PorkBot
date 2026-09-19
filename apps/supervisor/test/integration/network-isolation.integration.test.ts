import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planComputerNetwork } from "@porkbot/core";
import type { ComputerNetworkPlan } from "@porkbot/core";
import { findRepoRoot } from "@porkbot/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker, dockerOrThrow, dockerQuietly } from "./docker.ts";

/**
 * The isolation policy against the real daemon (slice 7.1 acceptance: "each
 * bot's computer is on its own network and cannot reach another bot's computer
 * or host services").
 *
 * The unit suite proves the plan; this spec builds the networks the plan
 * describes and drives real containers to show three things a plan cannot:
 * a computer reaches its own network, a computer on another bot's network is
 * refused, and a host service is unreachable even though it is listening. The
 * host probe targets both the default bridge's gateway and the isolated
 * network's own first address, so a regression that reintroduced a gateway
 * (the difference between `internal` alone and an isolated gateway mode) would
 * be caught rather than declared safe by a structural check.
 *
 * Everything is named with a random suffix and removed in `afterAll`, so the
 * suite runs beside the stack and a failed assertion does not leave a
 * container behind.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const register = JSON.parse(readFileSync(path.join(repoRoot, "dependencies.json"), "utf8")) as {
  images: { name: string; reference: string }[];
};
const nodeImage = register.images.find((image) => image.name === "node")?.reference;

if (nodeImage === undefined) {
  throw new Error("dependencies.json registers no node image for the isolation suite");
}

const suffix = Math.random().toString(36).slice(2, 8);
const botA = { botId: `isolation-bot-a-${suffix}`, computerId: `isolation-computer-a-${suffix}` };
const botB = { botId: `isolation-bot-b-${suffix}`, computerId: `isolation-computer-b-${suffix}` };

const planA: ComputerNetworkPlan = planComputerNetwork(botA);
const planB: ComputerNetworkPlan = planComputerNetwork(botB);

const serverContainer = `porkbot-isolation-server-${suffix}`;
const testPort = 8099;
const createdContainers: string[] = [];

let hostServer: Server | undefined;
let hostPort = 0;

function startContainer(args: readonly string[]): string {
  const id = dockerOrThrow(["run", "-d", "--rm", ...args]).trim();

  if (id !== "") {
    createdContainers.push(id);
  }

  return id;
}

function probe(
  network: string,
  url: string,
): { readonly reached: boolean; readonly output: string } {
  const script =
    `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(3000)})` +
    `.then(()=>{console.log("REACHED");process.exit(0)})` +
    `.catch((e)=>{console.log("BLOCKED",(e.cause&&e.cause.code)||e.name);process.exit(1)})`;
  const result = docker([
    "run",
    "--rm",
    "--network",
    network,
    nodeImage ?? "",
    "node",
    "-e",
    script,
  ]);

  return {
    reached: result.stdout.includes("REACHED"),
    output: `${result.stdout.trim()}\n${result.stderr.trim()}`,
  };
}

async function waitForServer(container: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = docker([
      "exec",
      container,
      "node",
      "-e",
      `fetch("http://127.0.0.1:${testPort}").then(()=>process.exit(0)).catch(()=>process.exit(1))`,
    ]);

    if (result.status === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("the isolation suite's server container never answered");
}

/** The first address on a subnet, where a gateway would sit. */
function firstHostAddress(subnet: string): string | undefined {
  const [base, prefix] = subnet.split("/");
  const octets = (base ?? "").split(".").map(Number);

  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet)) ||
    prefix === undefined
  ) {
    return undefined;
  }

  octets[3] = (octets[3] ?? 0) + 1;

  return octets.join(".");
}

interface NetworkInspection {
  readonly Internal: boolean;
  readonly Driver: string;
  readonly Options: Record<string, string> | null;
  readonly IPAM: { readonly Config?: { readonly Subnet?: string; readonly Gateway?: string }[] };
}

function networkJson(name: string): NetworkInspection {
  const [inspected] = JSON.parse(
    dockerOrThrow(["network", "inspect", name]),
  ) as NetworkInspection[];

  if (inspected === undefined) {
    throw new Error(`docker network inspect ${name} returned nothing`);
  }

  return inspected;
}

beforeAll(async () => {
  for (const plan of [planA, planB]) {
    // The provider (slice 7.2) will translate the plan into exactly these
    // flags; the suite pins the translation so the plan and the daemon agree.
    dockerOrThrow([
      "network",
      "create",
      "--driver",
      plan.driver,
      ...(plan.internal ? ["--internal"] : []),
      "--opt",
      `com.docker.network.bridge.gateway_mode_ipv4=${plan.gatewayMode}`,
      plan.name,
    ]);
  }

  startContainer([
    "--name",
    serverContainer,
    "--network",
    planA.name,
    "--entrypoint",
    "node",
    nodeImage ?? "",
    "-e",
    `require('http').createServer((q,s)=>s.end('ok')).listen(${testPort},'0.0.0.0')`,
  ]);
  await waitForServer(serverContainer);

  hostServer = createServer((_request, response) => response.end("host"));
  await new Promise<void>((resolve) => {
    hostServer?.listen(0, "0.0.0.0", resolve);
  });

  const address = hostServer.address();
  hostPort = address !== null && typeof address === "object" ? address.port : 0;
});

afterAll(async () => {
  for (const container of createdContainers.reverse()) {
    dockerQuietly(["rm", "-f", container]);
  }

  for (const plan of [planA, planB]) {
    dockerQuietly(["network", "rm", plan.name]);
  }

  await new Promise<void>((resolve) => {
    if (hostServer === undefined) {
      resolve();
      return;
    }

    hostServer.close(() => resolve());
  });
});

describe("the per-computer network the plan describes", () => {
  it("is internal, bridged and has no gateway address", () => {
    for (const plan of [planA, planB]) {
      const inspected = networkJson(plan.name);

      expect(inspected.Driver).toBe("bridge");
      expect(inspected.Internal).toBe(true);
      expect(inspected.Options?.["com.docker.network.bridge.gateway_mode_ipv4"]).toBe("isolated");
      expect(inspected.IPAM.Config?.[0]?.Gateway).toBeUndefined();
    }

    expect(planA.name).not.toBe(planB.name);
  });

  it("lets a computer reach a machine on its own network", () => {
    const sameNetwork = probe(planA.name, `http://${serverContainer}:${testPort}`);

    expect(sameNetwork.reached, sameNetwork.output).toBe(true);
  });

  it("refuses a computer on another bot's network", () => {
    const foreign = probe(planB.name, `http://${serverContainer}:${testPort}`);

    expect(foreign.reached, foreign.output).toBe(false);
  });

  it("refuses the host's services even though they listen on every interface", () => {
    const defaultGateway = dockerOrThrow([
      "network",
      "inspect",
      "bridge",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
    ]);
    const subnet = networkJson(planA.name).IPAM.Config?.[0]?.Subnet ?? "";
    const wouldBeGateway = firstHostAddress(subnet);

    const attacks = [
      `http://${defaultGateway}:${hostPort}`,
      ...(wouldBeGateway === undefined ? [] : [`http://${wouldBeGateway}:${hostPort}`]),
    ];

    for (const attack of attacks) {
      const blocked = probe(planA.name, attack);

      expect(blocked.reached, `${attack} was reachable: ${blocked.output}`).toBe(false);
    }
  });
});
