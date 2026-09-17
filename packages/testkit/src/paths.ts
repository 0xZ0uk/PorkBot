import { existsSync } from "node:fs";
import path from "node:path";

// The pnpm workspace file is the marker every script can rely on: it exists
// exactly once per repository, at the root, and it is what makes a directory
// "the repo" rather than "some directory a test happened to run in".
export const workspaceMarker = "pnpm-workspace.yaml";

/**
 * Walks up from `startDir` until the workspace marker is found. Config files and
 * CLIs run from a package directory and need the repository root to find the
 * quarantine ledger; guessing it from a relative path breaks the moment a task
 * runs from a different working directory, so the walk is the whole mechanism.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);

  for (;;) {
    if (existsSync(path.join(current, workspaceMarker))) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error(
        `Could not find ${workspaceMarker} above ${startDir}, so the repository root is unknown. ` +
          "Run this from inside the workspace.",
      );
    }

    current = parent;
  }
}

/** True when `candidate` is `directory` or lives inside it. */
export function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
