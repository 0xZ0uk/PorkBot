#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { findRepoRoot } from "../paths.ts";
import { artifactManifestFileName, parseTarget, sha512FileBase64, targetKey } from "./artifact.ts";
import type { ArtifactTarget } from "./artifact.ts";
import { releaseNotesMarkdown } from "./notes.ts";
import {
  desktopPackageDirectory,
  desktopVersion,
  packageDesktop,
  readBuildManifest,
} from "./package-app.ts";
import { parseReleaseManifest, signReleaseManifest, verifyReleaseManifest } from "./signing.ts";
import { smokeDesktopApp } from "./smoke.ts";
import { bumpVersion, isReleaseVersion, releaseTag } from "./version.ts";

/**
 * The release pipeline's single entry point (slice 11.7).
 *
 * Every step is a subcommand so CI, a maintainer and a smoke run use the same
 * code rather than three spellings of it:
 *
 *   node packages/testkit/src/release/cli.ts bump patch
 *   node packages/testkit/src/release/cli.ts package --out .release
 *   node packages/testkit/src/release/cli.ts sign --tag desktop-v0.2.0 --repo owner/name
 *   node packages/testkit/src/release/cli.ts verify
 *   node packages/testkit/src/release/cli.ts notes --version 0.2.0
 *   node packages/testkit/src/release/cli.ts smoke --app <binary> --server-url http://127.0.0.1:3199
 *
 * `package` and `smoke` are what the `desktop` CI tier runs; `sign` is the only
 * step that reads the release key, and it reads it from
 * `PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY` unless a file is named.
 */

interface CliOptions {
  readonly repoRoot: string;
  readonly out: string;
  readonly targets: readonly ArtifactTarget[];
  readonly tag?: string;
  readonly repo?: string;
  readonly privateKeyFile?: string;
  readonly publicKey?: string;
  readonly publicKeyFile?: string;
  readonly version?: string;
  readonly from?: string;
  readonly to?: string;
  readonly app?: string;
  readonly serverUrl?: string;
  readonly timeoutSeconds?: number;
  readonly help: boolean;
}

const defaultOut = ".release";
const defaultTargets = "linux-x64";

function usage(): string {
  return [
    "Usage: release <command> [options]",
    "",
    "Commands:",
    "  bump <major|minor|patch|X.Y.Z>  Write the next desktop version into apps/desktop/package.json.",
    "  package                         Package the desktop app for each target into --out.",
    "  sign                            Sign each artifact's digest into update-<platform>-<arch>.json.",
    "  verify                          Verify every artifact digest and every signed update manifest.",
    "  notes                           Print release notes generated from the git log.",
    "  smoke                           Start a packaged app and walk its first-run flow.",
    "  check-version                   Fail unless apps/desktop/package.json already names --version.",
    "",
    "Options:",
    `  --out <dir>            Artifact directory (default: ${defaultOut}).`,
    `  --targets <list>       Comma-separated platform-arch list (default: ${defaultTargets}).`,
    "  --tag <tag>            Release tag, e.g. desktop-v0.2.0 (sign; required).",
    "  --repo <owner/name>    GitHub repository for artifact URLs (sign; default: $GITHUB_REPOSITORY).",
    "  --private-key-file <path>  Release key PEM (sign; default: $PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY).",
    "  --public-key <value>   Pinned public key, PEM or base64 SPKI (verify).",
    "  --public-key-file <path>   File holding the pinned public key (verify).",
    "  --version <X.Y.Z>      Release version (notes and check-version; required).",
    "  --from <ref>           Previous release tag (notes; default: the last desktop-v tag).",
    "  --to <ref>             Revision to describe (notes; default: HEAD).",
    "  --app <path>           Packaged executable to launch (smoke; required).",
    "  --server-url <url>     Running PorkBot server the app is pointed at (smoke; required).",
    "  --timeout-seconds <n>  Smoke budget (default: 45).",
    "  --repo-root <path>     Repository root (default: found by walking up for pnpm-workspace.yaml).",
    "  --help                 This text.",
  ].join("\n");
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (value === undefined) {
    throw new Error(`${flag} needs a value.`);
  }

  return value;
}

function parseArguments(argv: readonly string[]): {
  command: string;
  argument: string;
  options: CliOptions;
} {
  const positional: string[] = [];
  let repoRoot: string | undefined;
  let out = defaultOut;
  let targets = defaultTargets;
  let tag: string | undefined;
  let repo: string | undefined;
  let privateKeyFile: string | undefined;
  let publicKey: string | undefined;
  let publicKeyFile: string | undefined;
  let version: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let app: string | undefined;
  let serverUrl: string | undefined;
  let timeoutSeconds: number | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--repo-root":
        repoRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--out":
        out = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--targets":
        targets = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--tag":
        tag = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--repo":
        repo = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--private-key-file":
        privateKeyFile = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--public-key":
        publicKey = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--public-key-file":
        publicKeyFile = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--version":
        version = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--from":
        from = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--to":
        to = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--app":
        app = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--server-url":
        serverUrl = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--timeout-seconds": {
        const seconds = Number(valueAfter(argv, index, argument));

        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error("--timeout-seconds needs a positive number of seconds.");
        }

        timeoutSeconds = seconds;
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (argument !== undefined) {
          positional.push(argument);
        }
    }
  }

  const command = positional[0] ?? "";
  const argument = positional[1] ?? "";
  const parsedTargets = targets
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const target = parseTarget(entry);

      if (target === undefined) {
        throw new Error(`"${entry}" is not a platform-arch target like linux-x64.`);
      }

      return target;
    });

  const options: CliOptions = {
    repoRoot: repoRoot ?? findRepoRoot(),
    out,
    targets: parsedTargets,
    ...(tag === undefined ? {} : { tag }),
    ...(repo === undefined ? {} : { repo }),
    ...(privateKeyFile === undefined ? {} : { privateKeyFile }),
    ...(publicKey === undefined ? {} : { publicKey }),
    ...(publicKeyFile === undefined ? {} : { publicKeyFile }),
    ...(version === undefined ? {} : { version }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(app === undefined ? {} : { app }),
    ...(serverUrl === undefined ? {} : { serverUrl }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    help,
  };

  return { command, argument, options };
}

function git(
  repoRoot: string,
  args: readonly string[],
  options: { readonly quietStderr?: boolean } = {},
): string {
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quietStderr === true ? "ignore" : "inherit"],
  }).trim();
}

async function readKey(options: CliOptions): Promise<string> {
  if (options.privateKeyFile !== undefined) {
    return readFile(options.privateKeyFile, "utf8");
  }

  const fromEnvironment = process.env["PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY"];

  if (fromEnvironment === undefined || fromEnvironment.trim().length === 0) {
    throw new Error(
      "the release key is not configured: set PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY or pass --private-key-file.",
    );
  }

  return fromEnvironment;
}

async function commandPackage(options: CliOptions): Promise<void> {
  const version = options.version ?? (await desktopVersion(options.repoRoot));
  const commit = git(options.repoRoot, ["rev-parse", "HEAD"]);
  const outDir = path.resolve(options.repoRoot, options.out);
  const result = await packageDesktop({
    repoRoot: options.repoRoot,
    outDir,
    version,
    commit,
    targets: options.targets,
    log: (message) => process.stdout.write(`  ${message}\n`),
  });

  for (const artifact of result.manifest.artifacts) {
    process.stdout.write(`${artifact.file}  ${artifact.sha512}\n`);
  }

  process.stdout.write(`wrote ${path.relative(options.repoRoot, result.manifestPath)}\n`);
}

function updateManifestPath(artifactsDir: string, artifact: ArtifactTarget): string {
  return path.join(artifactsDir, `update-${targetKey(artifact)}.json`);
}

async function commandSign(options: CliOptions): Promise<void> {
  const tag = options.tag;

  if (tag === undefined) {
    throw new Error("sign needs --tag, e.g. --tag desktop-v0.2.0.");
  }

  const repo = options.repo ?? process.env["GITHUB_REPOSITORY"];

  if (repo === undefined || repo.length === 0) {
    throw new Error("sign needs --repo owner/name or GITHUB_REPOSITORY.");
  }

  const server = (process.env["GITHUB_SERVER_URL"] ?? "https://github.com").replace(/\/$/, "");
  const artifactsDir = path.resolve(options.repoRoot, options.out);
  const manifest = await readBuildManifest(path.join(artifactsDir, artifactManifestFileName));
  const key = await readKey(options);

  for (const artifact of manifest.artifacts) {
    const url = `${server}/${repo}/releases/download/${tag}/${artifact.file}`;
    const signed = signReleaseManifest({
      version: manifest.version,
      url,
      sha512: artifact.sha512,
      privateKeyPem: key,
    });

    if (!signed.ok) {
      throw new Error(signed.message);
    }

    const file = updateManifestPath(artifactsDir, artifact);

    await writeFile(file, `${JSON.stringify(signed.manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`${path.basename(file)}  ${signed.manifest.signature}\n`);
  }

  // Hex, so `sha512sum -c checksums.txt` verifies a download; the manifests
  // keep base64 because that is the encoding the app's signature covers.
  const checksums = manifest.artifacts
    .map(
      (artifact) => `${Buffer.from(artifact.sha512, "base64").toString("hex")}  ${artifact.file}`,
    )
    .join("\n");

  await writeFile(path.join(artifactsDir, "checksums.txt"), `${checksums}\n`, "utf8");
  process.stdout.write("wrote checksums.txt\n");
}

async function publicKeyFor(options: CliOptions): Promise<string> {
  if (options.publicKey !== undefined) {
    return options.publicKey;
  }

  if (options.publicKeyFile !== undefined) {
    return readFile(options.publicKeyFile, "utf8");
  }

  const fromEnvironment = process.env["PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY"];

  if (fromEnvironment === undefined || fromEnvironment.trim().length === 0) {
    throw new Error(
      "verify needs --public-key, --public-key-file or PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY.",
    );
  }

  return fromEnvironment;
}

async function commandVerify(options: CliOptions): Promise<void> {
  const artifactsDir = path.resolve(options.repoRoot, options.out);
  const manifest = await readBuildManifest(path.join(artifactsDir, artifactManifestFileName));
  const publicKey = await publicKeyFor(options);
  let verified = 0;

  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(artifactsDir, artifact.file);
    const digest = await sha512FileBase64(artifactPath);

    if (digest !== artifact.sha512) {
      throw new Error(`${artifact.file} does not match the digest in ${artifactManifestFileName}.`);
    }

    const manifestFile = updateManifestPath(artifactsDir, artifact);

    if (!existsSync(manifestFile)) {
      throw new Error(`${path.basename(manifestFile)} is missing; run sign before verify.`);
    }

    const parsed = parseReleaseManifest(JSON.parse(await readFile(manifestFile, "utf8")));

    if (!parsed.ok) {
      throw new Error(`${path.basename(manifestFile)}: ${parsed.message}`);
    }

    const verifiedManifest = verifyReleaseManifest(parsed.manifest, publicKey);

    if (!verifiedManifest.ok) {
      throw new Error(`${path.basename(manifestFile)}: ${verifiedManifest.message}`);
    }

    if (
      parsed.manifest.version !== manifest.version ||
      parsed.manifest.sha512 !== artifact.sha512
    ) {
      throw new Error(`${path.basename(manifestFile)} does not describe ${artifact.file}.`);
    }

    verified += 1;
    process.stdout.write(`ok  ${artifact.file}  v${manifest.version}\n`);
  }

  process.stdout.write(`verified ${verified} artifact(s) against the pinned public key\n`);
}

async function commandNotes(options: CliOptions): Promise<void> {
  // The manifest's version is the default, so `release notes` describes the
  // checkout as it stands; a release names the version it is publishing.
  const version = options.version ?? (await desktopVersion(options.repoRoot));

  if (!isReleaseVersion(version)) {
    throw new Error(`"${version}" is not a major.minor.patch version.`);
  }

  const to = options.to ?? "HEAD";
  let from = options.from;

  if (from === undefined) {
    try {
      from = git(options.repoRoot, ["describe", "--tags", "--abbrev=0", "--match", "desktop-v*"], {
        quietStderr: true,
      });
    } catch {
      // No previous release tag; the notes cover the whole history.
      from = undefined;
    }
  }

  const range = from === undefined ? [to] : [`${from}..${to}`];
  const log = git(options.repoRoot, ["log", "--no-merges", "--pretty=format:%h%x09%s", ...range]);

  process.stdout.write(releaseNotesMarkdown({ version, ref: to, log }));
}

async function commandBump(options: CliOptions, bump: string): Promise<void> {
  const manifestPath = path.join(options.repoRoot, desktopPackageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const current = manifest["version"];

  if (typeof current !== "string") {
    throw new Error("apps/desktop/package.json has no version.");
  }

  const next = bumpVersion(current, bump);

  if (!next.ok) {
    throw new Error(next.message);
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, version: next.version }, null, 2)}\n`,
  );
  process.stdout.write(`${current} -> ${next.version}\n`);
}

async function commandCheckVersion(options: CliOptions): Promise<void> {
  const version = options.version;

  if (version === undefined || !isReleaseVersion(version)) {
    throw new Error("check-version needs --version X.Y.Z.");
  }

  const declared = await desktopVersion(options.repoRoot);

  if (declared !== version) {
    throw new Error(
      `apps/desktop/package.json declares ${declared}, not ${version}. ` +
        "Run release bump in a pull request and merge it before releasing.",
    );
  }

  const tag = releaseTag(version);
  const existing = git(options.repoRoot, ["tag", "--list", tag]);

  if (existing.length > 0) {
    throw new Error(`${tag} already exists; a release tag is never reused.`);
  }

  process.stdout.write(`${tag}\n`);
}

async function commandSmoke(options: CliOptions): Promise<void> {
  if (options.app === undefined || options.serverUrl === undefined) {
    throw new Error("smoke needs --app <path> and --server-url <url>.");
  }

  await smokeDesktopApp({
    appPath: options.app,
    serverUrl: options.serverUrl,
    ...(options.timeoutSeconds === undefined ? {} : { timeoutMs: options.timeoutSeconds * 1_000 }),
    log: (message) => process.stdout.write(`  ${message}\n`),
  });
}

function commandFor(argv: readonly string[]): Promise<void> {
  const { command, argument, options } = parseArguments(argv);

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return Promise.resolve();
  }

  switch (command) {
    case "":
    case "help":
      process.stdout.write(`${usage()}\n`);
      return Promise.resolve();
    case "bump":
      if (argument.length === 0) {
        throw new Error("bump needs a keyword (major, minor, patch) or a version.");
      }

      return commandBump(options, argument);
    case "package":
      return commandPackage(options);
    case "sign":
      return commandSign(options);
    case "verify":
      return commandVerify(options);
    case "notes":
      return commandNotes(options);
    case "smoke":
      return commandSmoke(options);
    case "check-version":
      return commandCheckVersion(options);
    default:
      throw new Error(`"${command}" is not a release command. Run release --help.`);
  }
}

try {
  await commandFor(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`release: ${(error as Error).message}\n`);
  process.exit(1);
}
