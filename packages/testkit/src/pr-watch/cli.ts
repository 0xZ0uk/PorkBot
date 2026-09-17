#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";
import { runCli } from "./commands.ts";
import { createGhClient, execGhRunner } from "./github.ts";

/**
 * The entry point the pr-watch skill invokes:
 *
 *   node packages/testkit/src/pr-watch/cli.ts --watch
 *
 * Only wiring lives here: the real `gh` runner, stdout/stderr, the wall clock,
 * and the local branch state the digest needs to report an out-of-sync
 * checkout. Everything decision-shaped is in commands.ts, where tests reach it.
 */

function gitValue(args: readonly string[]): string | null {
  try {
    const value = execFileSync("git", [...args], { encoding: "utf8" }).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  client: createGhClient(execGhRunner()),
  io: {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  env: process.env,
  git: {
    branch: gitValue(["branch", "--show-current"]),
    head: gitValue(["rev-parse", "HEAD"]),
    upstream: gitValue(["rev-parse", "@{upstream}"]),
  },
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
});
