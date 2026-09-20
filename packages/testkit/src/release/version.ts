/**
 * Desktop version arithmetic (slice 11.7).
 *
 * The desktop app's version lives in `apps/desktop/package.json`, and a release
 * is the tag `desktop-v<version>`: the version is the release's identity, the
 * artifact filename and the update manifest all name it, so the bump is a
 * scripted edit rather than a manual one that can disagree with the tag.
 *
 * The parsing here is deliberately a strict subset of what the app's update
 * check accepts: `major.minor.patch` only, never a pre-release or build
 * suffix. The app ignores a `-rc.1` suffix when comparing, but a release must
 * not mint one, because an artifact's version is its identity and `0.2.0-rc.1`
 * would sort equal to `0.2.0` while naming different bytes.
 */

export type ReleaseBump = "major" | "minor" | "patch";

export type VersionResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string };

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseReleaseVersion(
  version: string,
): readonly [number, number, number] | undefined {
  const match = versionPattern.exec(version.trim());

  if (match === null) {
    return undefined;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isReleaseVersion(version: string): boolean {
  return parseReleaseVersion(version) !== undefined;
}

function format(parts: readonly [number, number, number]): string {
  return parts.join(".");
}

/**
 * The version a bump produces. `bump` is a keyword or an explicit version; an
 * explicit version may only move forward, because a release tag cannot be
 * reused and a re-release of the same version would be a different artifact
 * under an immovable name.
 */
export function bumpVersion(current: string, bump: ReleaseBump | string): VersionResult {
  const parts = parseReleaseVersion(current);

  if (parts === undefined) {
    return { ok: false, message: `"${current}" is not a major.minor.patch version.` };
  }

  if (bump === "major") {
    return { ok: true, version: format([parts[0] + 1, 0, 0]) };
  }

  if (bump === "minor") {
    return { ok: true, version: format([parts[0], parts[1] + 1, 0]) };
  }

  if (bump === "patch") {
    return { ok: true, version: format([parts[0], parts[1], parts[2] + 1]) };
  }

  const explicit = parseReleaseVersion(bump);

  if (explicit === undefined) {
    return {
      ok: false,
      message: `"${bump}" is not a bump keyword (major, minor, patch) or a version.`,
    };
  }

  if (compareReleaseVersions(format(explicit), current) <= 0) {
    return { ok: false, message: `${format(explicit)} must be greater than ${current}.` };
  }

  return { ok: true, version: format(explicit) };
}

/** Positive when `candidate` is newer than `current`; zero when equal. */
export function compareReleaseVersions(candidate: string, current: string): number {
  const left = parseReleaseVersion(candidate);
  const right = parseReleaseVersion(current);

  if (left === undefined || right === undefined) {
    return Number.NaN;
  }

  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/** The release tag for a version; one spelling, computed here. */
export function releaseTag(version: string): string {
  return `desktop-v${version}`;
}
