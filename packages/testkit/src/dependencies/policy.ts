import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { postgresImage } from "../harness/images.ts";
import { discoverImageReferences, validateImageReferences } from "./image-refs.ts";
import { packageEntryKey, parseLockfile, stripPeerSuffix } from "./lockfile.ts";
import type { ParsedLockfile } from "./lockfile.ts";
import { readRegister, registerFilePath } from "./register.ts";
import type { DependencyRegister } from "./register.ts";

/**
 * The dependency policy, applied to the repository: the register, the workspace
 * manifests, the lockfile and every image reference have to agree. Each check
 * names the file a reviewer should open, because the point of the policy is not
 * to say "no" — it is to make the reason for a version visible in the diff.
 */

export const lockfileName = "pnpm-lock.yaml";

const dependencyGroups = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export interface WorkspaceManifest {
  /** Repository-relative path, e.g. `packages/adapters/package.json`. */
  readonly file: string;
  /** The lockfile importer key, e.g. `packages/adapters` or `.`. */
  readonly importer: string;
  /** Dependency name -> the specifier as written in the manifest. */
  readonly declarations: ReadonlyMap<string, string>;
}

export interface RepositoryCheck {
  readonly errors: readonly string[];
  readonly register: DependencyRegister;
}

export function readWorkspaceManifests(repoRoot: string): {
  manifests: WorkspaceManifest[];
  errors: string[];
} {
  const manifests: WorkspaceManifest[] = [];
  const errors: string[] = [];

  for (const group of ["apps", "packages"]) {
    let entries: Dirent[];

    try {
      entries = readdirSync(path.join(repoRoot, group), { withFileTypes: true });
    } catch {
      errors.push(`${group}/ could not be read; expected a workspace directory.`);
      continue;
    }

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory()) {
        continue;
      }

      const file = path.join(group, entry.name, "package.json");
      const absolute = path.join(repoRoot, file);
      let raw: string;

      try {
        raw = readFileSync(absolute, "utf8");
      } catch {
        errors.push(`${file} is missing; every workspace package has a manifest.`);
        continue;
      }

      let manifest: Record<string, unknown>;

      try {
        manifest = JSON.parse(raw) as Record<string, unknown>;
      } catch (error) {
        errors.push(`${file} is not valid JSON: ${(error as Error).message}`);
        continue;
      }

      const declarations = new Map<string, string>();

      for (const dependencyGroup of dependencyGroups) {
        const groupValue = manifest[dependencyGroup];

        if (typeof groupValue !== "object" || groupValue === null || Array.isArray(groupValue)) {
          continue;
        }

        for (const [name, specifier] of Object.entries(groupValue)) {
          if (typeof specifier === "string") {
            declarations.set(name, specifier);
          }
        }
      }

      manifests.push({
        file: file.split(path.sep).join("/"),
        importer: path.join(group, entry.name).split(path.sep).join("/"),
        declarations,
      });
    }
  }

  return { manifests, errors };
}

export function readLockfile(file: string): { lockfile: ParsedLockfile; errors: string[] } {
  try {
    return { lockfile: parseLockfile(readFileSync(file, "utf8")), errors: [] };
  } catch {
    return {
      lockfile: { importers: new Map(), packages: new Map() },
      errors: [
        `${path.basename(file)} is missing. Every dependency resolves through it; run pnpm install ` +
          "and commit the result.",
      ],
    };
  }
}

/**
 * The pin itself: the register says one exact version, the manifest that
 * declares the package must write exactly that, and the lockfile must resolve
 * exactly that with an integrity hash. Drift in any one of the three is the
 * failure mode the whole policy exists for.
 */
export function validatePins(
  register: DependencyRegister,
  manifests: readonly WorkspaceManifest[],
  lockfile: ParsedLockfile,
): string[] {
  const errors: string[] = [];

  for (const pin of register.packages) {
    let declared = false;

    for (const manifest of manifests) {
      const specifier = manifest.declarations.get(pin.name);

      if (specifier === undefined) {
        continue;
      }

      declared = true;

      if (specifier !== pin.version) {
        errors.push(
          `${manifest.file} declares ${pin.name} as "${specifier}", but dependencies.json pins ` +
            `${pin.version}. A pin moves only with an explicit version bump in both files; edit ` +
            "dependencies.json and the manifest together, then re-run pnpm install.",
        );
        continue;
      }

      const entry = lockfile.importers.get(manifest.importer)?.get(pin.name);

      if (entry === undefined) {
        errors.push(
          `pnpm-lock.yaml has no ${pin.name} entry for the ${manifest.importer} importer; ` +
            "run pnpm install and commit the lockfile.",
        );
        continue;
      }

      if (entry.specifier !== pin.version) {
        errors.push(
          `pnpm-lock.yaml records ${pin.name} in ${manifest.importer} with specifier ` +
            `"${entry.specifier}", not the pinned "${pin.version}"; run pnpm install and commit the lockfile.`,
        );
      }

      const resolved = stripPeerSuffix(entry.version);

      if (resolved !== pin.version) {
        errors.push(
          `the lockfile resolves ${pin.name} to ${resolved} while dependencies.json pins ` +
            `${pin.version}. The pin moved without a bump; either match the pin or bump it deliberately.`,
        );
      }

      const resolvedEntry = lockfile.packages.get(packageEntryKey(pin.name, pin.version));

      if (resolvedEntry?.integrity === undefined) {
        errors.push(
          `pnpm-lock.yaml resolves ${pin.name}@${pin.version} without an integrity hash, so the ` +
            "tarball is not pinned to a proven artifact; run pnpm install against the registry.",
        );
      }
    }

    if (!declared) {
      errors.push(
        `${pin.name}@${pin.version} is pinned in dependencies.json but no workspace package ` +
          "declares it. A pin that nothing uses is a liability; declare it in the package that " +
          "will import it, or delete the pin.",
      );
    }
  }

  return errors;
}

/** Every resolved package carries the hash its tarball was fetched under. */
export function validateLockfileProvenance(lockfile: ParsedLockfile): string[] {
  const errors: string[] = [];

  for (const entry of lockfile.packages.values()) {
    if (entry.integrity === undefined) {
      errors.push(
        `pnpm-lock.yaml resolves ${entry.name}@${entry.version} without an integrity hash. A ` +
          "dependency with provenance comes from a registry and carries its hash; a git, file or " +
          "tarball resolution is not pinned and does not become one by entering the lockfile.",
      );
    }
  }

  return errors;
}

function validateHarnessImage(register: DependencyRegister): string[] {
  const registered = register.images.find((image) => image.name === "postgres");

  if (registered === undefined) {
    return [
      "dependencies.json has no image named postgres, but the testkit harness boots one; " +
        "register the digest-pinned reference.",
    ];
  }

  if (registered.reference !== postgresImage) {
    return [
      `the testkit harness boots ${postgresImage}, but dependencies.json registers ` +
        `${registered.reference} for postgres. Update both together, so the tier runs the image ` +
        "the register names.",
    ];
  }

  return [];
}

export function checkRepository(repoRoot: string): RepositoryCheck {
  const { register, errors: registerErrors } = readRegister(registerFilePath(repoRoot));
  const errors = [...registerErrors];

  const { manifests, errors: manifestErrors } = readWorkspaceManifests(repoRoot);
  errors.push(...manifestErrors);

  const { lockfile, errors: lockfileErrors } = readLockfile(path.join(repoRoot, lockfileName));
  errors.push(...lockfileErrors);

  errors.push(...validatePins(register, manifests, lockfile));
  errors.push(...validateLockfileProvenance(lockfile));

  const discovered = discoverImageReferences(repoRoot);
  errors.push(...discovered.errors);
  errors.push(...validateImageReferences(register, discovered.references));
  errors.push(...validateHarnessImage(register));

  return { errors, register };
}
