import { spawnSync } from "node:child_process";

/**
 * The Docker CLI, for the deployment tier only (slice 7.1).
 *
 * The supervisor's unit suite runs with no daemon; these helpers exist for the
 * two things only the real thing can prove — which container mounts the socket
 * and whether an isolated network actually isolates. The supervisor app never
 * shells out to Docker; the Docker provider (slice 7.2) speaks the socket
 * through its adapter, and this file is test-only.
 */

export interface DockerResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function docker(args: readonly string[], timeoutMs = 60_000): DockerResult {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

/** Runs Docker and fails the test with the daemon's own words when it refuses. */
export function dockerOrThrow(args: readonly string[], timeoutMs = 60_000): string {
  const result = docker(args, timeoutMs);

  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout.trim();
}

/** Best-effort cleanup: a container or network that is already gone is fine. */
export function dockerQuietly(args: readonly string[]): void {
  docker(args);
}
