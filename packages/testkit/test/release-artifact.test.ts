import { describe, expect, it } from "vitest";
import {
  artifactFileName,
  bundleDirectoryName,
  createBuildManifest,
  packagedExecutable,
  parseBuildManifest,
  parseTarget,
  sha512Base64,
  targetKey,
} from "../src/release/artifact.ts";
import { entriesToRemove } from "../src/release/package-app.ts";

const commit = "3f9c2a1b0d4e5f60718293a4b5c6d7e8f9012345";

describe("artifact names and targets", () => {
  it("pins the version, the platform and the commit into the filename", () => {
    expect(
      artifactFileName({
        version: "0.2.0",
        commit,
        platform: "linux",
        arch: "x64",
      }),
    ).toBe("PorkBot-0.2.0-linux-x64-3f9c2a1b0d4e.tar.gz");
  });

  it("reads targets and refuses a spelling that names no platform", () => {
    expect(targetKey(parseTarget("darwin-arm64") ?? { platform: "linux", arch: "x64" })).toBe(
      "darwin-arm64",
    );
    expect(parseTarget("linux-riscv64")).toBeUndefined();
    expect(parseTarget("plan9-x64")).toBeUndefined();
  });

  it("knows where each platform puts the app and its executable", () => {
    expect(bundleDirectoryName({ platform: "darwin", arch: "arm64" })).toBe("PorkBot-darwin-arm64");
    expect(packagedExecutable({ platform: "darwin", arch: "arm64" })).toBe(
      "PorkBot.app/Contents/MacOS/PorkBot",
    );
    expect(packagedExecutable({ platform: "win32", arch: "x64" })).toBe("PorkBot.exe");
    expect(packagedExecutable({ platform: "linux", arch: "x64" })).toBe("PorkBot");
  });

  it("hashes artifact bytes as base64 SHA-512", () => {
    expect(sha512Base64(Buffer.from("porkbot"))).toHaveLength(88);
  });
});

describe("the build manifest", () => {
  const manifest = createBuildManifest({
    version: "0.2.0",
    commit,
    electron: "44.4.3",
    builtAt: "2026-09-20T00:00:00.000Z",
    artifacts: [
      {
        platform: "linux",
        arch: "x64",
        file: "PorkBot-0.2.0-linux-x64-3f9c2a1b0d4e.tar.gz",
        sha512: "digest",
        sizeBytes: 1,
      },
    ],
  });

  it("round-trips and names the app, the version and the full commit", () => {
    const parsed = parseBuildManifest(JSON.parse(JSON.stringify(manifest)));

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.manifest.app).toBe("PorkBot");
      expect(parsed.manifest.commit).toBe(commit);
      expect(parsed.manifest.artifacts).toHaveLength(1);
    }
  });

  it("refuses a short commit, an empty artifact list and a foreign app", () => {
    expect(parseBuildManifest({ ...manifest, commit: "3f9c2a1" }).ok).toBe(false);
    expect(parseBuildManifest({ ...manifest, artifacts: [] }).ok).toBe(false);
    expect(parseBuildManifest({ ...manifest, app: "SomethingElse" }).ok).toBe(false);
  });
});

describe("staging prune", () => {
  it("keeps only the built output, its dependencies and the manifest in the app root", () => {
    expect(
      entriesToRemove(
        ["dist", "node_modules", "package.json", "src", "tsconfig.json", "vitest.config.ts"],
        ["dist", "node_modules", "package.json"],
      ),
    ).toEqual(["src", "tsconfig.json", "vitest.config.ts"]);
  });

  it("keeps only the build output, manifest and license in a workspace dependency", () => {
    expect(
      entriesToRemove(
        ["dist", "package.json", "LICENSE", "src", "test", "eslint.config.js"],
        ["dist", "package.json", "LICENSE"],
      ),
    ).toEqual(["src", "test", "eslint.config.js"]);
  });
});
