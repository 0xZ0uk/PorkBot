import { describe, expect, it } from "vitest";
import { docker, dockerOrThrow } from "./docker.ts";

/**
 * The running deployment's socket inventory (slice 7.1 acceptance: "the API
 * container has no Docker socket mounted, verified by inspecting the running
 * deployment").
 *
 * `compose.yaml` says where the socket goes; this spec asks the daemon where
 * it actually went. CI starts the stack with `pnpm stack:up` before this tier
 * runs, so the containers exist; a developer running the tier without a stack
 * is told to start one rather than handed a passing test that inspected
 * nothing.
 */

const project = "porkbot";

function containerIdFor(service: string): string | undefined {
  const result = docker([
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ]);

  const id = result.stdout.trim();

  return id === "" ? undefined : id.split("\n")[0];
}

function runningServiceNames(): string[] {
  const output = dockerOrThrow([
    "ps",
    "--format",
    '{{.Label "com.docker.compose.service"}}',
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
}

function dockerSocketMounts(containerId: string): string[] {
  const raw = dockerOrThrow(["inspect", containerId, "--format", "{{json .Mounts}}"]);
  const mounts = JSON.parse(raw) as { Source?: string; Destination?: string }[];

  return mounts
    .filter(
      (mount) =>
        mount.Source?.includes("docker.sock") || mount.Destination?.includes("docker.sock"),
    )
    .map((mount) => mount.Destination ?? mount.Source ?? "unknown");
}

describe("the running stack", () => {
  it("has the services this slice inspects", () => {
    const services = runningServiceNames();

    expect(
      services.length === 0 ? "the stack is not running; run pnpm stack:up first" : services,
    ).toEqual(expect.arrayContaining(["api", "supervisor"]));
  });

  it("mounts no Docker socket into the API container", () => {
    const api = containerIdFor("api");

    expect(api, "the api container is not running; run pnpm stack:up first").toBeDefined();
    expect(dockerSocketMounts(api ?? "")).toEqual([]);
  });

  it("mounts the Docker socket into the supervisor container, and only there", () => {
    const services = runningServiceNames();
    const withSocket = services.filter(
      (service) => dockerSocketMounts(containerIdFor(service) ?? "").length > 0,
    );

    expect(withSocket).toEqual(["supervisor"]);
  });

  it("gives the API the supervisor's address and credential, not a socket path", () => {
    const api = containerIdFor("api") ?? "";
    const raw = dockerOrThrow(["inspect", api, "--format", "{{json .Config.Env}}"]);
    const environment = JSON.parse(raw) as string[];
    const names = environment.map((entry) => entry.split("=")[0] ?? "");

    expect(names).toContain("PORKBOT_SUPERVISOR_URL");
    expect(names).toContain("PORKBOT_SUPERVISOR_TOKEN");
    expect(environment.join("\n")).not.toContain("/var/run/docker.sock");
  });

  it("lets the API reach the supervisor's authenticated surface over the compose network", () => {
    const api = containerIdFor("api");

    expect(api, "the api container is not running; run pnpm stack:up first").toBeDefined();

    // The API process's own network and credential, used from inside its
    // container: the supervisor answers, and the list it returns is the
    // provider's current inventory (empty on a fresh stack).
    const script =
      'fetch("http://supervisor:3003/v1/computers",{method:"POST",' +
      'headers:{authorization:"Bearer "+process.env.PORKBOT_SUPERVISOR_TOKEN,' +
      '"x-porkbot-supervisor-protocol":"1","content-type":"application/json"},' +
      'body:"{}"}).then((r)=>r.json()).then((b)=>{process.exit(Array.isArray(b.computers)?0:1)})' +
      ".catch(()=>process.exit(1))";
    const reached = docker(["exec", api ?? "", "node", "-e", script]);

    expect(reached.status, reached.stderr).toBe(0);

    const refused = docker([
      "exec",
      api ?? "",
      "node",
      "-e",
      script.replace(
        'authorization:"Bearer "+process.env.PORKBOT_SUPERVISOR_TOKEN',
        'authorization:"Bearer wrong-token"',
      ),
    ]);

    expect(refused.status).not.toBe(0);
  });
});
