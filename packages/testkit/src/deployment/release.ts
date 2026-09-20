import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The small amount of release state the deployment needs beyond its env file.
 *
 * The environment file is the active configuration and remains the source of
 * truth for Compose. This adjacent, non-secret file only records which image
 * tag was active immediately before the last successful switch, so rollback
 * does not have to guess from whatever images happen to remain cached.
 */
export interface ReleaseState {
  readonly active: string;
  readonly previous: string | null;
}

export const releaseStateFileName = ".release-state";

export function releaseStatePath(envFile: string): string {
  return path.join(path.dirname(envFile), releaseStateFileName);
}

function assertTag(tag: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tag) || tag.toLowerCase() === "latest") {
    throw new Error(`${label} is not a release image tag`);
  }
}

function writeAtomically(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });

  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
}

/** Reads the release state, returning null before the first successful start. */
export function readReleaseState(filePath: string): ReleaseState | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const values = new Map<string, string>();

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator <= 0) {
      throw new Error(`the release state ${filePath} contains an invalid line`);
    }

    values.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const active = values.get("active")?.trim() ?? "";
  const previous = values.get("previous")?.trim() ?? "";

  if (active === "") {
    throw new Error(`the release state ${filePath} has no active tag`);
  }

  assertTag(active, "the active release tag");

  if (previous !== "") {
    assertTag(previous, "the previous release tag");
  }

  return { active, previous: previous === "" ? null : previous };
}

/** Records a successful release switch without putting credentials in state. */
export function writeReleaseState(filePath: string, state: ReleaseState): void {
  assertTag(state.active, "the active release tag");

  if (state.previous !== null) {
    assertTag(state.previous, "the previous release tag");
  }

  writeAtomically(
    filePath,
    [
      `# PorkBot release state; image tags only, no credentials.`,
      `active=${state.active}`,
      `previous=${state.previous ?? ""}`,
      "",
    ].join("\n"),
  );
}

/** Rewrites only the image tag while preserving the operator's env comments. */
export function replaceImageTag(envFile: string, tag: string): void {
  assertTag(tag, "the image tag");

  const source = readFileSync(envFile, "utf8");
  const lines = source.split("\n");
  let matches = 0;

  const replaced = lines.map((line) => {
    if (!/^PORKBOT_IMAGE_TAG=/.test(line)) {
      return line;
    }

    matches += 1;
    return `PORKBOT_IMAGE_TAG=${tag}`;
  });

  if (matches !== 1) {
    throw new Error(
      `expected exactly one PORKBOT_IMAGE_TAG setting in ${envFile}, found ${String(matches)}`,
    );
  }

  writeAtomically(envFile, replaced.join("\n"));
}
