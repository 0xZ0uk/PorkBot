import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  composeImageReferences,
  dockerfileImageReferences,
  validateImageReferences,
  workflowImageReferences,
} from "../src/dependencies/image-refs.ts";
import {
  diffLockfiles,
  formatLockfileDiff,
  isEmptyDiff,
  parseLockfile,
  stripPeerSuffix,
} from "../src/dependencies/lockfile.ts";
import type { ParsedLockfile } from "../src/dependencies/lockfile.ts";
import {
  checkRepository,
  readWorkspaceManifests,
  validateLockfileProvenance,
  validatePins,
} from "../src/dependencies/policy.ts";
import type { WorkspaceManifest } from "../src/dependencies/policy.ts";
import {
  isDigestReference,
  isExactVersion,
  parseRegisterValue,
  readRegister,
  registerFilePath,
} from "../src/dependencies/register.ts";
import type { DependencyRegister } from "../src/dependencies/register.ts";
import { findRepoRoot } from "../src/paths.ts";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

const pinnedName = "@earendil-works/pi-agent-core";
const pinnedVersion = "1.2.3";
const goodImageDigest = "sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
const goodIntegrity =
  "sha512-hIXIP3eAWueAYiAl8aMvWCvvZ8Q5gT3Dip5bE5uJyIGh4+YlWRjtMLI4BaeoXoSs93zndjue61u1B/vhefLnuA==";

function registerWith(
  packages: readonly { name: string; version: string; reason?: string }[] = [
    { name: pinnedName, version: pinnedVersion },
  ],
): DependencyRegister {
  const parsed = parseRegisterValue({
    version: 1,
    packages: packages.map((entry) => ({
      reason: entry.reason ?? "the policy asserts on this pin in the test suite",
      ...entry,
    })),
    images: [
      {
        name: "postgres",
        reference: `postgres:18@${goodImageDigest}`,
        reason: "the test suite boots this image and expects it registered",
      },
    ],
  });

  expect(parsed.errors, parsed.errors.join("\n")).toEqual([]);

  return parsed.register;
}

function manifestWith(
  declarations: Record<string, string>,
  file = "packages/adapters/package.json",
): WorkspaceManifest {
  return {
    file,
    importer: file.replace(/\/package\.json$/, ""),
    declarations: new Map(Object.entries(declarations)),
  };
}

function lockfileWith(
  entries: {
    version?: string;
    specifier?: string;
    /** `null` writes a resolution without an integrity hash. */
    integrity?: string | null;
    name?: string;
  } = {},
): ParsedLockfile {
  const name = entries.name ?? pinnedName;
  const version = entries.version ?? pinnedVersion;
  const specifier = entries.specifier ?? pinnedVersion;
  const integrity = entries.integrity === undefined ? goodIntegrity : entries.integrity;
  const integrityLine =
    integrity === null
      ? "    resolution: {directory: .}"
      : `    resolution: {integrity: ${integrity}}`;

  return parseLockfile(
    [
      `lockfileVersion: '9.0'`,
      "",
      "importers:",
      "",
      "  packages/adapters:",
      "    dependencies:",
      `      '${name}':`,
      `        specifier: ${specifier}`,
      `        version: ${version}(ws@8.21.3)`,
      "",
      "packages:",
      "",
      `  '${name}@${version}':`,
      integrityLine,
      "",
    ].join("\n"),
  );
}

describe("the dependency register", () => {
  it("accepts the checked-in register", () => {
    const { register, errors } = readRegister(registerFilePath(repoRoot));

    expect(errors, errors.join("\n")).toEqual([]);
    expect(register.packages.length).toBeGreaterThan(0);
    expect(register.images.length).toBeGreaterThan(0);
  });

  it("requires an exact version for a pinned package", () => {
    expect(isExactVersion(pinnedVersion)).toBe(true);
    expect(isExactVersion("^1.2.3")).toBe(false);
    expect(isExactVersion("latest")).toBe(false);

    const parsed = parseRegisterValue({
      version: 1,
      packages: [{ name: pinnedName, version: "^1.2.3", reason: "ranges are not pins at all" }],
      images: [],
    });

    expect(parsed.errors.join("\n")).toContain("exact version");
  });

  it("requires a tag and a digest for a pinned image", () => {
    expect(isDigestReference(`postgres:18@${goodImageDigest}`)).toBe(true);
    expect(isDigestReference("postgres:18")).toBe(false);
    expect(isDigestReference(`postgres@${goodImageDigest}`)).toBe(false);

    const parsed = parseRegisterValue({
      version: 1,
      packages: [],
      images: [{ name: "postgres", reference: "postgres:18", reason: "a tag moves" }],
    });

    expect(parsed.errors.join("\n")).toContain("tag and a digest");
  });

  it("rejects a reason too short to review and a duplicate pin", () => {
    const short = parseRegisterValue({
      version: 1,
      packages: [{ name: pinnedName, version: pinnedVersion, reason: "because" }],
      images: [],
    });

    expect(short.errors.join("\n")).toContain("too short");

    const duplicate = parseRegisterValue({
      version: 1,
      packages: [
        { name: pinnedName, version: pinnedVersion, reason: "the first reason stands here" },
        { name: pinnedName, version: "1.2.4", reason: "the second reason stands here" },
      ],
      images: [],
    });

    expect(duplicate.errors.join("\n")).toContain("twice");
  });
});

describe("pin drift", () => {
  it("passes when the register, the manifest and the lockfile agree", () => {
    expect(
      validatePins(registerWith(), [manifestWith({ [pinnedName]: pinnedVersion })], lockfileWith()),
    ).toEqual([]);
  });

  it("fails when the manifest moves the pin", () => {
    const errors = validatePins(
      registerWith(),
      [manifestWith({ [pinnedName]: "1.2.4" })],
      lockfileWith({ version: "1.2.4" }),
    );

    expect(errors.join("\n")).toContain("explicit version bump");
  });

  it("fails when the manifest writes a range instead of the pinned version", () => {
    const errors = validatePins(
      registerWith(),
      [manifestWith({ [pinnedName]: "^1.2.3" })],
      lockfileWith(),
    );

    expect(errors.join("\n")).toContain("explicit version bump");
  });

  it("fails when the register moves but the manifest does not", () => {
    const errors = validatePins(
      registerWith([{ name: pinnedName, version: "1.2.4" }]),
      [manifestWith({ [pinnedName]: pinnedVersion })],
      lockfileWith(),
    );

    expect(errors.join("\n")).toContain("explicit version bump");
  });

  it("fails when the lockfile resolves a different version", () => {
    const errors = validatePins(
      registerWith(),
      [manifestWith({ [pinnedName]: pinnedVersion })],
      lockfileWith({ version: "1.2.4" }),
    );

    expect(errors.join("\n")).toContain("resolves");
  });

  it("fails when the pinned package is registered but nothing declares it", () => {
    const errors = validatePins(registerWith(), [], lockfileWith());

    expect(errors.join("\n")).toContain("no workspace package declares it");
  });

  it("fails when the pinned resolution has no integrity hash", () => {
    const errors = validatePins(
      registerWith(),
      [manifestWith({ [pinnedName]: pinnedVersion })],
      lockfileWith({ integrity: null }),
    );

    expect(errors.join("\n")).toContain("integrity hash");
  });
});

describe("lockfile provenance", () => {
  it("accepts resolutions that carry an integrity hash", () => {
    expect(validateLockfileProvenance(lockfileWith({ integrity: goodIntegrity }))).toEqual([]);
  });

  it("rejects a resolution without one", () => {
    const errors = validateLockfileProvenance(lockfileWith({ integrity: null }));

    expect(errors.join("\n")).toContain("without an integrity hash");
  });

  it("strips peer suffixes from resolved versions", () => {
    expect(stripPeerSuffix("0.85.1(ws@8.21.3)")).toBe("0.85.1");
  });
});

describe("the lockfile diff", () => {
  const base = parseLockfile(
    [
      "packages:",
      "",
      "  'left-pad@1.0.0':",
      "    resolution: {integrity: sha512-bGVmdA==}",
      "",
      "  'moved@1.0.0':",
      "    resolution: {integrity: sha512-bW92ZWQ=}",
      "",
      "  'gone@2.0.0':",
      "    resolution: {integrity: sha512-Z29uZQ==}",
      "",
    ].join("\n"),
  );

  const head = parseLockfile(
    [
      "importers:",
      "",
      "  packages/adapters:",
      "    dependencies:",
      "      'left-pad':",
      "        specifier: 1.0.0",
      "        version: 1.0.0",
      "",
      "packages:",
      "",
      "  'left-pad@1.0.0':",
      "    resolution: {integrity: sha512-bmV3ZA==}",
      "",
      "  'moved@1.0.1':",
      "    resolution: {integrity: sha512-bW92ZWQ=}",
      "",
      "  'fresh@3.0.0':",
      "    resolution: {integrity: sha512-bmV3ZA==}",
      "",
    ].join("\n"),
  );

  it("reads importers and packages out of pnpm's shape", () => {
    expect(head.importers.get("packages/adapters")?.get("left-pad")).toEqual({
      specifier: "1.0.0",
      version: "1.0.0",
    });
    expect(head.packages.get("moved@1.0.1")?.integrity).toBe("sha512-bW92ZWQ=");
  });

  it("reports added, removed, updated and integrity-only changes", () => {
    const diff = diffLockfiles(base, head);

    expect(diff.added.map((change) => change.name)).toContain("fresh");
    expect(diff.removed.map((change) => change.name)).toContain("gone");
    expect(diff.updated.find((change) => change.name === "moved")?.after?.version).toBe("1.0.1");
    expect(diff.updated.find((change) => change.name === "left-pad")?.before?.integrity).toBe(
      "sha512-bGVmdA==",
    );
    expect(diff.importers).toEqual([
      {
        importer: "packages/adapters",
        name: "left-pad",
        before: undefined,
        after: { specifier: "1.0.0", version: "1.0.0" },
      },
    ]);
  });

  it("formats the diff as markdown a reviewer can read", () => {
    const markdown = formatLockfileDiff(diffLockfiles(base, head), "origin/main");

    expect(markdown).toContain("| updated | moved | `1.0.0` | `1.0.1` |");
    expect(markdown).toContain("| added | fresh |");
    expect(markdown).toContain("| removed | gone |");
    expect(markdown).toContain("Workspace dependency changes:");
    expect(isEmptyDiff(diffLockfiles(head, head))).toBe(true);
    expect(formatLockfileDiff(diffLockfiles(head, head), "HEAD")).toContain("No lockfile change");
  });
});

describe("image references", () => {
  const reference = `postgres:18@${goodImageDigest}`;

  it("extracts FROM lines but not scratch, stages or build-args-as-stages", () => {
    const dockerfile = [
      "# syntax=docker/dockerfile:1",
      "FROM node:24.13.0@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef AS build",
      "RUN echo build",
      "FROM build AS test",
      "FROM scratch",
      `FROM ${reference}`,
    ].join("\n");

    expect(dockerfileImageReferences(dockerfile)).toEqual([
      {
        line: 2,
        reference:
          "node:24.13.0@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      { line: 6, reference },
    ]);
  });

  it("extracts image lines from Compose, quotes and comments included", () => {
    const compose = [
      "services:",
      "  db:",
      `    image: ${reference}`,
      "  cache:",
      '    image: "redis:8" # floating',
    ].join("\n");

    expect(composeImageReferences(compose)).toEqual([
      { line: 3, reference },
      { line: 5, reference: "redis:8" },
    ]);
  });

  it("extracts docker pull commands from workflows", () => {
    const workflow = [
      "jobs:",
      "  integration:",
      "    steps:",
      `      - run: docker pull ${reference}`,
    ].join("\n");

    expect(workflowImageReferences(workflow)).toEqual([{ line: 4, reference }]);
  });

  it("requires a digest and a register entry", () => {
    const register = registerWith();

    expect(validateImageReferences(register, [{ source: "Dockerfile:1", reference }])).toEqual([]);

    expect(
      validateImageReferences(register, [
        { source: "Dockerfile:1", reference: "postgres:18" },
      ]).join("\n"),
    ).toContain("not pinned by digest");

    expect(
      validateImageReferences(register, [
        {
          source: "Dockerfile:1",
          reference: `redis:8@${goodImageDigest}`,
        },
      ]).join("\n"),
    ).toContain("not in dependencies.json");

    expect(
      validateImageReferences(register, [
        { source: "Dockerfile:1", reference: `postgres:latest@${goodImageDigest}` },
      ]).join("\n"),
    ).toContain("latest");
  });
});

describe("the repository's own policy", () => {
  it("holds for the register, manifests, lockfile and images in the tree", () => {
    const { errors } = checkRepository(repoRoot);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("pins Pi to exactly what the adapters manifest declares", () => {
    const { register } = readRegister(registerFilePath(repoRoot));
    const { manifests, errors } = readWorkspaceManifests(repoRoot);
    const adapters = manifests.find(
      (manifest) => manifest.file === "packages/adapters/package.json",
    );
    const pipin = register.packages.find((pin) => pin.name === "@earendil-works/pi-agent-core");

    expect(errors, errors.join("\n")).toEqual([]);
    expect(adapters).toBeDefined();
    expect(pipin, "the register must pin Pi").toBeDefined();
    expect(isExactVersion(pipin?.version)).toBe(true);
    expect(adapters?.declarations.get("@earendil-works/pi-agent-core")).toBe(pipin?.version);
  });

  it("keeps save-exact, which is what makes pnpm add a pin", () => {
    const npmrc = readFileSync(path.join(repoRoot, ".npmrc"), "utf8");

    expect(npmrc).toMatch(/^save-exact=true$/m);
  });
});
