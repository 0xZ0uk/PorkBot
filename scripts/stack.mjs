#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The one command that starts the local stack: `pnpm stack:up` (this script's
 * `up`). It shells out to `docker compose` with the repository's compose.yaml,
 * builds the app images, and blocks on `--wait`, which returns only once every
 * service's healthcheck passes. `pnpm stack:down` removes the containers, the
 * network and the Postgres volume, so a re-run starts from the same state.
 *
 * CI runs the same command (`.github/workflows/ci.yml`, the integration job), so
 * a stack that works for a developer is the stack that gates a merge.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const composeFile = path.join(repoRoot, "compose.yaml");
const project = process.env["PORKBOT_STACK_PROJECT"] ?? "porkbot";
const waitSeconds = process.env["PORKBOT_STACK_WAIT_SECONDS"] ?? "300";
const apiPort = process.env["PORKBOT_API_PORT"] ?? "3001";
const proxyPort = process.env["PORKBOT_REVERSE_PROXY_PORT"] ?? "8080";
const postgresPort = process.env["PORKBOT_POSTGRES_PORT"] ?? "5432";

function usage() {
  return [
    "Usage: node scripts/stack.mjs <command>",
    "",
    "Commands:",
    "  up      Build and start the stack, then wait for every healthcheck.",
    "  down    Stop the stack and remove its containers, network and volumes.",
    "  logs    Follow the logs of every service.",
    "  status  Show the state of every service.",
    "",
    "Environment:",
    "  PORKBOT_STACK_WAIT_SECONDS  Health wait budget for `up` (default: 300).",
    "  PORKBOT_STACK_PROJECT       Compose project name (default: porkbot).",
    "  PORKBOT_POSTGRES_PORT       Host port for Postgres (default: 5432).",
    "  PORKBOT_API_PORT            Host port for the api (default: 3001).",
    "  PORKBOT_REVERSE_PROXY_PORT  Host port for the reverse proxy (default: 8080).",
    "  PORKBOT_API_DB_PASSWORD     The api role's password (default: a local placeholder).",
    "  PORKBOT_WORKER_DB_PASSWORD  The worker role's password (default: a local placeholder).",
    "",
  ].join("\n");
}

function composeArguments(args) {
  return ["compose", "--project-name", project, "--file", composeFile, ...args];
}

function compose(args) {
  return spawnSync("docker", composeArguments(args), { cwd: repoRoot, stdio: "inherit" });
}

function composeCaptured(args) {
  return spawnSync("docker", composeArguments(args), {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function exitCodeOf(result) {
  if (result.error !== undefined) {
    return 1;
  }

  return result.status ?? 1;
}

function preflight() {
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (docker.error !== undefined || docker.status !== 0) {
    process.stderr.write(
      "Docker is not available. Install Docker, start the daemon, then run `pnpm stack:up` again.\n",
    );
    process.exit(1);
  }

  const composeVersion = spawnSync("docker", ["compose", "version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (composeVersion.error !== undefined || composeVersion.status !== 0) {
    process.stderr.write(
      "Docker Compose v2 is not available (`docker compose`). Install it, then run `pnpm stack:up` again.\n",
    );
    process.exit(1);
  }

  return docker.stdout.trim();
}

function up() {
  const dockerVersion = preflight();

  process.stdout.write(
    `Starting the PorkBot stack with Docker ${dockerVersion}; waiting up to ${waitSeconds}s for every healthcheck.\n`,
  );

  const result = compose([
    "up",
    "--detach",
    "--build",
    "--remove-orphans",
    "--wait",
    "--wait-timeout",
    waitSeconds,
  ]);

  if (exitCodeOf(result) !== 0) {
    const logs = composeCaptured(["logs", "--tail", "80", "--no-color"]);

    process.stderr.write(
      `\nThe stack did not become healthy. Recent logs:\n\n${logs.stdout ?? ""}`,
    );
    process.stderr.write(
      "\nFix the failure and re-run `pnpm stack:up`, or remove the stack with `pnpm stack:down`.\n",
    );
    process.exit(exitCodeOf(result));
  }

  compose(["ps", "--format", "table {{.Service}}\t{{.Status}}\t{{.Ports}}"]);
  process.stdout.write(
    [
      "",
      "The stack is up and healthy:",
      `  proxy     http://localhost:${proxyPort} (the one origin: SPA, API, streams)`,
      `  api       http://127.0.0.1:${apiPort}/readyz`,
      `  postgres  127.0.0.1:${postgresPort}`,
      "",
      "Follow the logs with `pnpm stack:logs`, stop it with `pnpm stack:down`.",
      "",
    ].join("\n"),
  );
}

function down() {
  preflight();
  process.exit(exitCodeOf(compose(["down", "--volumes", "--remove-orphans", "--timeout", "30"])));
}

function logs() {
  preflight();
  process.exit(exitCodeOf(compose(["logs", "--follow", "--tail", "100", "--no-color"])));
}

function status() {
  preflight();
  process.exit(
    exitCodeOf(compose(["ps", "--format", "table {{.Service}}\t{{.Status}}\t{{.Ports}}"])),
  );
}

const command = process.argv[2];

switch (command) {
  case "up":
    up();
    break;
  case "down":
    down();
    break;
  case "logs":
    logs();
    break;
  case "status":
    status();
    break;
  case undefined:
  case "help":
    process.stdout.write(usage());
    break;
  default:
    process.stderr.write(`Unknown command "${command}".\n\n${usage()}`);
    process.exit(2);
}
