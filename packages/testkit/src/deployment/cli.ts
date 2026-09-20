#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findRepoRoot } from "../paths.ts";
import { runDeploy } from "./commands.ts";
import type { DeploymentContext, SpawnOptions, SpawnResult } from "./commands.ts";

/**
 * The deployment CLI (slice 12.1). It reads files, writes the one env file and
 * shells out to `docker compose`; every decision lives in `commands.ts`, where
 * the test suite reaches it, and this file is the wiring.
 *
 *   node packages/testkit/src/deployment/cli.ts setup --origin https://bots.example.com
 *   node packages/testkit/src/deployment/cli.ts check --compose
 *   node packages/testkit/src/deployment/cli.ts up
 */

function spawn(command: string, args: readonly string[], options: SpawnOptions = {}): SpawnResult {
  const result = spawnSync(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: options.inherit === true ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

/** The checkout's release tag, or null when this is not a git checkout. */
function imageTag(): string | null {
  try {
    const value = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return value === "" ? null : value;
  } catch {
    return null;
  }
}

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

const context: DeploymentContext = {
  repoRoot,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  spawn,
  randomBytes,
  imageTag,
};

const invoked = process.argv[1];

if (invoked !== undefined && import.meta.url === pathToFileURL(path.resolve(invoked)).href) {
  process.exitCode = runDeploy(process.argv.slice(2), context);
}
