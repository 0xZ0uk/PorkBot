/**
 * What a release artifact is (slice 11.7).
 *
 * An artifact is one packaged app for one platform and architecture, named so
 * the three things a release promises are visible without opening it: the app
 * version, the platform it runs on, and the git commit it was built from. The
 * commit stays in the filename rather than only in a manifest because the
 * filename is what a download link, a mirror and an update manifest all carry;
 * a name that says `PorkBot-0.2.0-linux-x64-3f9c2a1b0d4e.tar.gz` cannot be
 * mistaken for a build of another revision.
 *
 * `build-manifest.json` is the machine-readable half: the version, the full
 * commit, the Electron version and the SHA-512 of every artifact in the
 * release. `sign` signs those digests into `update-<platform>-<arch>.json`,
 * which is the only thing the app trusts.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export const desktopAppName = "PorkBot";

export const desktopPlatforms = ["linux", "darwin", "win32"] as const;
export const desktopArchitectures = ["x64", "arm64"] as const;

export type DesktopPlatform = (typeof desktopPlatforms)[number];
export type DesktopArchitecture = (typeof desktopArchitectures)[number];

export interface ArtifactTarget {
  readonly platform: DesktopPlatform;
  readonly arch: DesktopArchitecture;
}

export const artifactManifestFileName = "build-manifest.json";

/** `linux-x64`; the key a target is named by on the command line and on disk. */
export function targetKey(target: ArtifactTarget): string {
  return `${target.platform}-${target.arch}`;
}

export function parseTarget(text: string): ArtifactTarget | undefined {
  const separator = text.lastIndexOf("-");
  const platform = text.slice(0, separator);
  const arch = text.slice(separator + 1);

  if (
    separator === -1 ||
    !desktopPlatforms.includes(platform as DesktopPlatform) ||
    !desktopArchitectures.includes(arch as DesktopArchitecture)
  ) {
    return undefined;
  }

  return { platform: platform as DesktopPlatform, arch: arch as DesktopArchitecture };
}

/** The directory @electron/packager writes inside the output directory. */
export function bundleDirectoryName(target: ArtifactTarget): string {
  return `${desktopAppName}-${targetKey(target)}`;
}

/** The executable a smoke test launches, relative to the bundle directory. */
export function packagedExecutable(target: ArtifactTarget): string {
  switch (target.platform) {
    case "darwin":
      return `${desktopAppName}.app/Contents/MacOS/${desktopAppName}`;
    case "win32":
      return `${desktopAppName}.exe`;
    case "linux":
      return desktopAppName;
  }
}

export interface ArtifactNameInput extends ArtifactTarget {
  readonly version: string;
  /** The full git commit the artifact was built from. */
  readonly commit: string;
}

export function artifactFileName(input: ArtifactNameInput): string {
  return `${desktopAppName}-${input.version}-${targetKey(input)}-${input.commit.slice(0, 12)}.tar.gz`;
}

export function sha512Base64(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

/** The digest of a file on disk, streamed: artifacts are hundreds of megabytes. */
export async function sha512FileBase64(file: string): Promise<string> {
  const hash = createHash("sha512");

  await pipeline(createReadStream(file), hash);

  return hash.digest("base64");
}

export interface BuildArtifact extends ArtifactTarget {
  readonly file: string;
  readonly sha512: string;
  readonly sizeBytes: number;
}

export interface BuildManifest {
  readonly schemaVersion: 1;
  readonly app: string;
  readonly version: string;
  readonly commit: string;
  readonly electron: string;
  readonly builtAt: string;
  readonly artifacts: readonly BuildArtifact[];
}

export function createBuildManifest(input: {
  readonly version: string;
  readonly commit: string;
  readonly electron: string;
  readonly builtAt: string;
  readonly artifacts: readonly BuildArtifact[];
}): BuildManifest {
  return {
    schemaVersion: 1,
    app: desktopAppName,
    version: input.version,
    commit: input.commit,
    electron: input.electron,
    builtAt: input.builtAt,
    artifacts: input.artifacts,
  };
}

export type BuildManifestResult =
  | { readonly ok: true; readonly manifest: BuildManifest }
  | { readonly ok: false; readonly message: string };

const commitPattern = /^[0-9a-f]{40}$/;

/** Reads a manifest strictly: a release's provenance is not a best-effort thing. */
export function parseBuildManifest(raw: unknown): BuildManifestResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "the build manifest is not an object." };
  }

  const record = raw as Record<string, unknown>;
  const version = record["version"];
  const commit = record["commit"];
  const electron = record["electron"];
  const builtAt = record["builtAt"];

  if (record["schemaVersion"] !== 1 || record["app"] !== desktopAppName) {
    return { ok: false, message: "the build manifest is not a PorkBot v1 manifest." };
  }

  if (typeof version !== "string" || typeof electron !== "string" || typeof builtAt !== "string") {
    return { ok: false, message: "the build manifest is missing its version, electron or date." };
  }

  if (typeof commit !== "string" || !commitPattern.test(commit)) {
    return { ok: false, message: "the build manifest does not name a full git commit." };
  }

  if (!Array.isArray(record["artifacts"]) || record["artifacts"].length === 0) {
    return { ok: false, message: "the build manifest lists no artifacts." };
  }

  const artifacts: BuildArtifact[] = [];

  for (const entry of record["artifacts"]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "the build manifest has an artifact that is not an object." };
    }

    const artifact = entry as Record<string, unknown>;
    const target = parseTarget(`${String(artifact["platform"])}-${String(artifact["arch"])}`);

    if (
      target === undefined ||
      typeof artifact["file"] !== "string" ||
      typeof artifact["sha512"] !== "string" ||
      typeof artifact["sizeBytes"] !== "number"
    ) {
      return { ok: false, message: "the build manifest has an incomplete artifact entry." };
    }

    artifacts.push({
      ...target,
      file: artifact["file"],
      sha512: artifact["sha512"],
      sizeBytes: artifact["sizeBytes"],
    });
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      app: desktopAppName,
      version,
      commit,
      electron,
      builtAt,
      artifacts,
    },
  };
}
