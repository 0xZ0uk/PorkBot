import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@porkbot/testkit";
import { describe, expect, it } from "vitest";

/**
 * The deployment shape the supervisor slice promises, checked where it lives.
 *
 * The integration tier inspects the running stack, which is the real proof
 * that the API container has no Docker socket; this suite reads the same
 * claim out of `compose.yaml` so a regression fails in the fast tier, before
 * anyone builds an image. The parse is deliberately structural: services are
 * identified by their two-space header, so a socket mentioned in a nested
 * block is attributed to the service that owns it rather than to the file.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const compose = readFileSync(path.join(repoRoot, "compose.yaml"), "utf8");

const dockerSocketPath = "/var/run/docker.sock";

function serviceBlocks(source: string): ReadonlyMap<string, string> {
  const lines = source.split("\n");
  const services: Map<string, string> = new Map();
  let inServices = false;
  let current: { name: string; lines: string[] } | undefined;

  function flush(): void {
    if (current !== undefined) {
      services.set(current.name, current.lines.join("\n"));
      current = undefined;
    }
  }

  for (const line of lines) {
    // A top-level key starts or ends the services section; the anchor block
    // (`x-app`) also has two-space keys, so only the section counts.
    if (/^\S/.test(line)) {
      flush();
      inServices = line === "services:";
      continue;
    }

    if (!inServices) {
      continue;
    }

    const header = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);

    if (header !== null) {
      flush();
      current = { name: header[1] ?? "", lines: [line] };
      continue;
    }

    if (current !== undefined) {
      current.lines.push(line);
    }
  }

  flush();
  return services;
}

function servicesMountingDockerSocket(source: string): string[] {
  return [...serviceBlocks(source)]
    .filter(([, block]) => block.includes(dockerSocketPath))
    .map(([name]) => name)
    .sort();
}

describe("the compose deployment", () => {
  it("parses the service blocks it means to assert on", () => {
    const services = serviceBlocks(compose);

    expect([...services.keys()].sort()).toEqual([
      "api",
      "backup",
      "migrate",
      "postgres",
      "proxy",
      "supervisor",
      "worker",
    ]);
  });

  it("mounts the Docker socket in the supervisor and in no other service", () => {
    expect(servicesMountingDockerSocket(compose)).toEqual(["supervisor"]);
  });

  it("gives the API the supervisor's address and credential instead of a socket", () => {
    const api = serviceBlocks(compose).get("api") ?? "";

    expect(api).not.toContain(dockerSocketPath);
    expect(api).toContain("PORKBOT_SUPERVISOR_URL: http://supervisor:3003");
    expect(api).toContain("PORKBOT_SUPERVISOR_TOKEN:");
  });

  it("configures the supervisor's process credential and screen key", () => {
    const supervisor = serviceBlocks(compose).get("supervisor") ?? "";

    expect(supervisor).toContain(`- ${dockerSocketPath}:${dockerSocketPath}`);
    expect(supervisor).toContain("PORKBOT_SUPERVISOR_TOKEN:");
    expect(supervisor).toContain("PORKBOT_SCREEN_TOKEN_SECRET:");
  });
});
