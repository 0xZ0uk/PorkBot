/**
 * Packaging the desktop app (slice 11.7).
 *
 * The packaged app is the web build plus the Electron shell plus the production
 * dependency closure, assembled from built output rather than from a checkout:
 * `pnpm deploy` copies the desktop package's real production dependencies into
 * a staging directory (hoisted, because an Electron app bundle cannot carry
 * pnpm's symlink farm through an archive), the staging directory is trimmed to
 * `dist/`, `node_modules/` and `package.json`, the web client is copied from
 * the build the web image serves, and @electron/packager wraps it in the
 * platform's runtime.
 * `extraResource` is what makes `resolveClientRoot` find `client/` beside the
 * app in a packaged run, which the smoke test then proves by starting the app.
 *
 * Nothing here decides a version or a signature: the caller names the version,
 * the build manifest records the commit and the digests, and `signing.ts` is
 * the only module that ever sees the release key.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packager } from "@electron/packager";
import {
  artifactFileName,
  artifactManifestFileName,
  bundleDirectoryName,
  createBuildManifest,
  desktopAppName,
  parseBuildManifest,
  sha512FileBase64,
  targetKey,
} from "./artifact.ts";
import type { ArtifactTarget, BuildArtifact, BuildManifest } from "./artifact.ts";
import { isReleaseVersion } from "./version.ts";

export const desktopPackageDirectory = "apps/desktop";
export const desktopClientDirectory = "apps/web/dist/client";

/** What stays in the staged app: the build output, its manifest and its dependencies. */
export const appRootKeep = ["dist", "node_modules", "package.json"] as const;
/** What stays in each staged workspace dependency. */
export const workspacePackageKeep = ["dist", "package.json", "LICENSE"] as const;

/** The entries of a directory that a prune removes, preserving `keep`. */
export function entriesToRemove(
  entries: readonly string[],
  keep: readonly string[],
): readonly string[] {
  return entries.filter((entry) => !keep.includes(entry));
}

export interface PackageDesktopOptions {
  readonly repoRoot: string;
  readonly outDir: string;
  readonly version: string;
  /** The full git commit the build is taken from. */
  readonly commit: string;
  readonly targets: readonly ArtifactTarget[];
  readonly log?: (message: string) => void;
  /** Injected in tests; defaults to the build clock. */
  readonly now?: () => Date;
}

export interface PackageDesktopResult {
  readonly manifest: BuildManifest;
  readonly manifestPath: string;
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const ending = code === null ? `signal ${String(signal)}` : `code ${String(code)}`;

      reject(new Error(`${command} ${args.join(" ")} exited with ${ending}.`));
    });
  });
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

/** The Electron version the app is built against, from the installed pin. */
export async function installedElectronVersion(repoRoot: string): Promise<string> {
  const manifest = path.join(
    repoRoot,
    desktopPackageDirectory,
    "node_modules",
    "electron",
    "package.json",
  );

  if (!existsSync(manifest)) {
    throw new Error(
      `Electron is not installed at ${path.relative(repoRoot, manifest)}; run pnpm install before packaging.`,
    );
  }

  const version = (await readJson(manifest))["version"];

  if (typeof version !== "string") {
    throw new Error("the installed electron package has no version.");
  }

  return version;
}

/** The version the desktop manifest declares; the release tag must match it. */
export async function desktopVersion(repoRoot: string): Promise<string> {
  const manifest = await readJson(path.join(repoRoot, desktopPackageDirectory, "package.json"));
  const version = manifest["version"];

  if (typeof version !== "string" || !isReleaseVersion(version)) {
    throw new Error("apps/desktop/package.json has no major.minor.patch version.");
  }

  return version;
}

/** Trims a deployed directory to the entries a packaged app needs. */
async function pruneDirectory(
  directory: string,
  keep: readonly string[],
  log: (message: string) => void,
): Promise<void> {
  for (const entry of entriesToRemove(await readdir(directory), keep)) {
    const removed = path.join(directory, entry);

    await rm(removed, { recursive: true, force: true });
    log(`pruned ${path.relative(directory, removed)}`);
  }
}

async function pruneWorkspacePackages(
  stage: string,
  log: (message: string) => void,
): Promise<void> {
  const scoped = path.join(stage, "node_modules", "@porkbot");

  if (!existsSync(scoped)) {
    return;
  }

  for (const entry of await readdir(scoped)) {
    await pruneDirectory(path.join(scoped, entry), workspacePackageKeep, log);
  }
}

async function archive(
  outDir: string,
  bundleDirectory: string,
  artifactPath: string,
): Promise<void> {
  await run(
    "tar",
    ["--create", "--gzip", "--file", artifactPath, "-C", outDir, bundleDirectory],
    outDir,
  );
}

export async function packageDesktop(
  options: PackageDesktopOptions,
): Promise<PackageDesktopResult> {
  const log = options.log ?? ((): void => {});
  const { repoRoot, outDir } = options;

  if (!isReleaseVersion(options.version)) {
    throw new Error(`"${options.version}" is not a major.minor.patch version.`);
  }

  if (!/^[0-9a-f]{40}$/.test(options.commit)) {
    throw new Error(`"${options.commit}" is not a full git commit.`);
  }

  if (options.targets.length === 0) {
    throw new Error("no artifact targets were named.");
  }

  const clientRoot = path.join(repoRoot, desktopClientDirectory);

  if (!existsSync(path.join(clientRoot, "_shell.html"))) {
    throw new Error(
      `${desktopClientDirectory} is missing; run pnpm build before packaging the desktop app.`,
    );
  }

  const electronVersion = await installedElectronVersion(repoRoot);
  await mkdir(outDir, { recursive: true });

  const stage = await mkdtemp(path.join(tmpdir(), "porkbot-desktop-stage-"));

  try {
    log(`staging the production dependency closure in ${stage}`);
    await run(
      "pnpm",
      [
        "--filter",
        `@porkbot/desktop`,
        "deploy",
        "--legacy",
        "--prod",
        "--config.node-linker=hoisted",
        stage,
      ],
      repoRoot,
    );

    await pruneDirectory(stage, appRootKeep, log);
    await pruneWorkspacePackages(stage, log);
    await cp(clientRoot, path.join(stage, "client"), { recursive: true });
    log("copied the web client into the app resources");

    const artifacts: BuildArtifact[] = [];

    for (const target of options.targets) {
      const key = targetKey(target);
      log(`packaging ${key} with Electron ${electronVersion}`);
      await packager({
        dir: stage,
        out: outDir,
        platform: target.platform,
        arch: target.arch,
        name: desktopAppName,
        appVersion: options.version,
        electronVersion,
        asar: true,
        overwrite: true,
        // The staging step already installed production dependencies; there is
        // nothing left to prune, and pruning a hoisted tree is what would break.
        prune: false,
        extraResource: [clientRoot],
      });

      const bundleDirectory = bundleDirectoryName(target);
      const file = artifactFileName({
        ...target,
        version: options.version,
        commit: options.commit,
      });
      const artifactPath = path.join(outDir, file);

      await archive(outDir, bundleDirectory, artifactPath);

      artifacts.push({
        ...target,
        file,
        sha512: await sha512FileBase64(artifactPath),
        sizeBytes: (await stat(artifactPath)).size,
      });
      log(`wrote ${file} (${artifacts[artifacts.length - 1]?.sizeBytes ?? 0} bytes)`);
    }

    const manifest = createBuildManifest({
      version: options.version,
      commit: options.commit,
      electron: electronVersion,
      builtAt: (options.now ?? (() => new Date()))().toISOString(),
      artifacts,
    });
    const manifestPath = path.join(outDir, artifactManifestFileName);

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    return { manifest, manifestPath };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Parses the build manifest a `package` run wrote. */
export async function readBuildManifest(file: string): Promise<BuildManifest> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  const result = parseBuildManifest(parsed);

  if (!result.ok) {
    throw new Error(`${file}: ${result.message}`);
  }

  return result.manifest;
}
