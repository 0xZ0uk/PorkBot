import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "../../src/paths.ts";

/**
 * Runs a real vitest process against one of the fixture configs and hands back
 * what it printed and how it exited. The retry policy, the timeout and the
 * quarantine ledger are all enforced by vitest itself, so the only honest way to
 * test them is to run vitest and read the result.
 */

export const testkitRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const repoRoot = findRepoRoot(testkitRoot);
export const fixturesDir = path.join(testkitRoot, "test", "fixtures", "flake");

export interface ChildRun {
  readonly code: number;
  readonly output: string;
}

export interface ChildRunOptions {
  readonly env?: Record<string, string>;
  /** Wall-clock ceiling for the child, in milliseconds. */
  readonly timeoutMs?: number;
}

export function runVitest(configFile: string, options: ChildRunOptions = {}): Promise<ChildRun> {
  const vitest = path.join(testkitRoot, "node_modules", ".bin", "vitest");
  const relativeConfig = path.relative(testkitRoot, path.join(fixturesDir, configFile));

  return new Promise((resolve, reject) => {
    execFile(
      vitest,
      ["run", "--config", relativeConfig, "--no-color"],
      {
        cwd: testkitRoot,
        timeout: options.timeoutMs ?? 120_000,
        // Unless a caller says otherwise, the child is told there is no job
        // summary: these tests read the reporter's output from stdout, and a
        // nested run must not append to the real runner's summary. It has to come
        // after the inherited environment, which is where CI sets that variable.
        env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...options.env },
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(new Error(`could not run vitest: ${error.message}\n${stderr}`));
          return;
        }

        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          output: `${stdout}${stderr}`,
        });
      },
    );
  });
}
