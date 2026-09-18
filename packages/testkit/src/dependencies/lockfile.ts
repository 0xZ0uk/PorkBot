/**
 * A small reader for `pnpm-lock.yaml`, enough to answer the two questions the
 * dependency policy asks: what does the lockfile resolve a pinned package to,
 * and does every resolution carry the integrity hash that makes it provenance
 * rather than a name?
 *
 * This is deliberately not a YAML parser. The lockfile is generated, its shape
 * is stable per lockfile version, and the alternative — taking a YAML library
 * as a dependency of the policy that vets dependencies — would be a joke the
 * reviewer would be right to reject.
 */

export interface LockfileDependency {
  readonly specifier: string;
  readonly version: string;
}

export interface LockfilePackage {
  readonly name: string;
  readonly version: string;
  /** The `sha512-…` hash from `resolution`; undefined when the entry has none. */
  readonly integrity: string | undefined;
}

export interface ParsedLockfile {
  /** importer path (`.` for the root) -> dependency name -> resolution. */
  readonly importers: ReadonlyMap<string, ReadonlyMap<string, LockfileDependency>>;
  /** `name@version` (peer suffix stripped) -> package entry. */
  readonly packages: ReadonlyMap<string, LockfilePackage>;
}

/** `name@version(peer@x)` -> the name and the bare version. */
export function splitPackageKey(key: string): { name: string; version: string } | undefined {
  const match = /^(@[^/@]+\/[^@]+|[^@/]+)@(.+)$/.exec(key);

  if (match === null) {
    return undefined;
  }

  return { name: match[1] ?? "", version: stripPeerSuffix(match[2] ?? "") };
}

/** `1.2.3(react@18.2.0)` -> `1.2.3`. Peer suffixes are lockfile bookkeeping. */
export function stripPeerSuffix(version: string): string {
  return version.split("(")[0] ?? version;
}

export function packageEntryKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const match = /^(['"])(.*)\1$/.exec(trimmed);

  return match === null ? trimmed : (match[2] ?? "");
}

function integrityOf(resolution: string): string | undefined {
  return /integrity:\s*([^,}\s]+)/.exec(resolution)?.[1];
}

export function parseLockfile(text: string): ParsedLockfile {
  const importers = new Map<string, Map<string, { specifier: string; version: string }>>();
  const packages = new Map<string, LockfilePackage>();

  let section = "";
  let importer = "";
  let group = "";
  let dependency = "";
  let pendingPackage: string | undefined;

  const flushPackage = (integrity: string | undefined): void => {
    if (pendingPackage === undefined) {
      return;
    }

    const parsed = splitPackageKey(pendingPackage);

    if (parsed !== undefined) {
      packages.set(packageEntryKey(parsed.name, parsed.version), {
        name: parsed.name,
        version: parsed.version,
        integrity,
      });
    }

    pendingPackage = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      flushPackage(undefined);
      section = line.endsWith(":") ? line.slice(0, -1) : "";
      importer = "";
      group = "";
      dependency = "";
      continue;
    }

    if (section === "importers") {
      if (indent === 2 && line.endsWith(":")) {
        importer = unquote(line.slice(0, -1));
        importers.set(importer, new Map());
        group = "";
        dependency = "";
      } else if (indent === 4 && line.endsWith(":")) {
        group = line.slice(0, -1);
        dependency = "";
      } else if (indent === 6 && line.endsWith(":")) {
        dependency = unquote(line.slice(0, -1));
        importers.get(importer)?.set(dependency, { specifier: "", version: "" });
      } else if (indent === 8 && group !== "" && dependency !== "") {
        const colon = line.indexOf(":");
        const key = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : unquote(line.slice(colon + 1));
        const entry = importers.get(importer)?.get(dependency);

        if (entry !== undefined) {
          if (key === "specifier") {
            entry.specifier = value;
          } else if (key === "version") {
            entry.version = value;
          }
        }
      }

      continue;
    }

    if (section === "packages") {
      if (indent === 2 && line.endsWith(":")) {
        flushPackage(undefined);
        pendingPackage = unquote(line.slice(0, -1));
      } else if (indent === 4 && line.startsWith("resolution:")) {
        flushPackage(integrityOf(line));
      }
    }
  }

  flushPackage(undefined);

  return { importers, packages };
}

export interface VersionedPackage {
  readonly version: string;
  readonly integrity: string | undefined;
}

export interface PackageChange {
  readonly name: string;
  readonly before: VersionedPackage | undefined;
  readonly after: VersionedPackage | undefined;
}

export interface ImporterChange {
  readonly importer: string;
  readonly name: string;
  readonly before: LockfileDependency | undefined;
  readonly after: LockfileDependency | undefined;
}

export interface LockfileDiff {
  readonly added: readonly PackageChange[];
  readonly removed: readonly PackageChange[];
  readonly updated: readonly PackageChange[];
  readonly importers: readonly ImporterChange[];
}

function groupedByName(lockfile: ParsedLockfile): Map<string, Map<string, string | undefined>> {
  const grouped = new Map<string, Map<string, string | undefined>>();

  for (const entry of lockfile.packages.values()) {
    const versions = grouped.get(entry.name) ?? new Map<string, string | undefined>();
    versions.set(entry.version, entry.integrity);
    grouped.set(entry.name, versions);
  }

  return grouped;
}

function packageChange(
  name: string,
  beforeVersion: string | undefined,
  beforeIntegrity: string | undefined,
  afterVersion: string | undefined,
  afterIntegrity: string | undefined,
): PackageChange {
  return {
    name,
    before:
      beforeVersion === undefined
        ? undefined
        : { version: beforeVersion, integrity: beforeIntegrity },
    after:
      afterVersion === undefined ? undefined : { version: afterVersion, integrity: afterIntegrity },
  };
}

export function diffLockfiles(base: ParsedLockfile, head: ParsedLockfile): LockfileDiff {
  const added: PackageChange[] = [];
  const removed: PackageChange[] = [];
  const updated: PackageChange[] = [];
  const before = groupedByName(base);
  const after = groupedByName(head);

  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const beforeVersions = before.get(name) ?? new Map<string, string | undefined>();
    const afterVersions = after.get(name) ?? new Map<string, string | undefined>();

    // The common case is one version before and one after: call it an update so
    // the reviewer reads "1.2.3 to 1.2.4" instead of two unrelated rows.
    if (beforeVersions.size === 1 && afterVersions.size === 1) {
      const [beforeVersion = ""] = [...beforeVersions.keys()];
      const [afterVersion = ""] = [...afterVersions.keys()];

      if (
        beforeVersion !== afterVersion ||
        beforeVersions.get(beforeVersion) !== afterVersions.get(afterVersion)
      ) {
        updated.push(
          packageChange(
            name,
            beforeVersion,
            beforeVersions.get(beforeVersion),
            afterVersion,
            afterVersions.get(afterVersion),
          ),
        );
      }

      continue;
    }

    for (const [version, integrity] of afterVersions) {
      if (!beforeVersions.has(version)) {
        added.push(packageChange(name, undefined, undefined, version, integrity));
      } else if (beforeVersions.get(version) !== integrity) {
        updated.push(packageChange(name, version, beforeVersions.get(version), version, integrity));
      }
    }

    for (const [version, integrity] of beforeVersions) {
      if (!afterVersions.has(version)) {
        removed.push(packageChange(name, version, integrity, undefined, undefined));
      }
    }
  }

  const importers: ImporterChange[] = [];
  const importerNames = new Set([...base.importers.keys(), ...head.importers.keys()]);

  for (const importer of importerNames) {
    const beforeDeps = base.importers.get(importer) ?? new Map<string, LockfileDependency>();
    const afterDeps = head.importers.get(importer) ?? new Map<string, LockfileDependency>();

    for (const name of new Set([...beforeDeps.keys(), ...afterDeps.keys()])) {
      const beforeDep = beforeDeps.get(name);
      const afterDep = afterDeps.get(name);

      if (
        beforeDep?.specifier !== afterDep?.specifier ||
        beforeDep?.version !== afterDep?.version
      ) {
        importers.push({ importer, name, before: beforeDep, after: afterDep });
      }
    }
  }

  return { added, removed, updated, importers };
}

export function isEmptyDiff(diff: LockfileDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.updated.length === 0 &&
    diff.importers.length === 0
  );
}

function shortIntegrity(integrity: string | undefined): string {
  return integrity === undefined ? "—" : `${integrity.slice(0, 16)}…`;
}

/** The version without the peer graph, which is noise unless it changed. */
function importerCell(entry: LockfileDependency | undefined): string {
  if (entry === undefined) {
    return "—";
  }

  const peers = entry.version.includes("(") ? " + peers" : "";

  return `\`${entry.specifier}\` (${stripPeerSuffix(entry.version)}${peers})`;
}

function versionCell(entry: VersionedPackage | undefined): string {
  return entry === undefined ? "—" : `\`${entry.version}\``;
}

/** The markdown a reviewer reads on the pull request. */
export function formatLockfileDiff(diff: LockfileDiff, baseLabel: string): string {
  if (isEmptyDiff(diff)) {
    return `No lockfile change against \`${baseLabel}\`.`;
  }

  const lines = [
    "### Lockfile changes",
    "",
    `Comparing \`pnpm-lock.yaml\` against \`${baseLabel}\`.`,
    "",
    "| change | package | before | after | integrity |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const change of diff.updated) {
    lines.push(
      `| updated | ${change.name} | ${versionCell(change.before)} | ${versionCell(change.after)} | ` +
        `${shortIntegrity(change.after?.integrity)} |`,
    );
  }

  for (const change of diff.added) {
    lines.push(
      `| added | ${change.name} | — | ${versionCell(change.after)} | ${shortIntegrity(change.after?.integrity)} |`,
    );
  }

  for (const change of diff.removed) {
    lines.push(
      `| removed | ${change.name} | ${versionCell(change.before)} | — | ${shortIntegrity(change.before?.integrity)} |`,
    );
  }

  if (diff.importers.length > 0) {
    lines.push(
      "",
      "Workspace dependency changes:",
      "",
      "| importer | dependency | before | after |",
      "| --- | --- | --- | --- |",
    );

    for (const change of diff.importers) {
      lines.push(
        `| ${change.importer} | ${change.name} | ${importerCell(change.before)} | ` +
          `${importerCell(change.after)} |`,
      );
    }
  }

  const counts = [
    `${diff.added.length} added`,
    `${diff.removed.length} removed`,
    `${diff.updated.length} updated`,
  ].join(", ");

  lines.push("", `${counts}; ${diff.importers.length} workspace specifier(s) changed.`, "");

  return lines.join("\n");
}
