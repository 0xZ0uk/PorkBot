import { basename, dirname, ShellIoError } from "./computer-shell.ts";
import type {
  DirectoryEntry,
  ShellBrowserCommand,
  ShellBrowserOutcome,
  ShellWorld,
} from "./computer-shell.ts";

/**
 * A shell world over an in-memory filesystem (slice 6.9, reused by 7.3).
 *
 * The offline computer and the cloud engine's emulator both need a shell whose
 * filesystem is a map of paths, so the two emulators show the same machine:
 * a file written by one command is the file the next command reads, a missing
 * parent is refused exactly as a real shell refuses it, and `destroy` drops
 * the map. Keeping the world in one module is what lets the same conformance
 * suite drive both emulators without either of them growing its own dialect.
 */

export interface FileNode {
  readonly kind: "file";
  readonly content: Uint8Array;
}

export interface DirectoryNode {
  readonly kind: "dir";
}

export type FileSystemNode = FileNode | DirectoryNode;

/** Every ancestor directory of an absolute path, the root first. */
export function pathAncestors(path: string): readonly string[] {
  const result: string[] = ["/"];

  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") {
      continue;
    }

    result.push(`${result.at(-1) === "/" ? "" : result.at(-1)}/${part}`);
  }

  return result;
}

/**
 * A move or a copy lands only where the parent already exists, exactly as
 * `mv` and `cp` do: writing an orphan entry would make a file that `ls` cannot
 * show and a real shell could not have produced.
 */
function requireParentDirectory(files: ReadonlyMap<string, FileSystemNode>, target: string): void {
  const parent = files.get(dirname(target));

  if (parent === undefined || parent.kind !== "dir") {
    throw new ShellIoError("No such file or directory");
  }
}

function cloneNodes(
  files: ReadonlyMap<string, FileSystemNode>,
  prefix: string,
): ReadonlyMap<string, FileSystemNode> {
  const clones = new Map<string, FileSystemNode>();
  const inside = (path: string): boolean =>
    prefix === "/" ? path.startsWith("/") : path === prefix || path.startsWith(`${prefix}/`);

  for (const [path, node] of files) {
    if (!inside(path)) {
      continue;
    }

    clones.set(
      path,
      node.kind === "file"
        ? { kind: "file", content: new Uint8Array(node.content) }
        : { kind: "dir" },
    );
  }

  return clones;
}

/** A deep copy of one map, so a snapshot cannot be edited through its source. */
export function cloneFileSystem(
  files: ReadonlyMap<string, FileSystemNode>,
): Map<string, FileSystemNode> {
  return new Map(cloneNodes(files, "/"));
}

/** A fresh filesystem with the root, the home ancestors and `/tmp`. */
export function createFileSystem(home: string): Map<string, FileSystemNode> {
  const files = new Map<string, FileSystemNode>([["/", { kind: "dir" }]]);

  for (const path of pathAncestors(home)) {
    files.set(path, { kind: "dir" });
  }

  files.set("/tmp", { kind: "dir" });
  return files;
}

export interface ShellWorldOptions {
  readonly files: Map<string, FileSystemNode>;
  readonly cwd: string;
  readonly browser: (command: ShellBrowserCommand) => ShellBrowserOutcome;
}

function listEntries(
  files: ReadonlyMap<string, FileSystemNode>,
  path: string,
  includeHidden: boolean,
): readonly DirectoryEntry[] {
  const prefix = path === "/" ? "/" : `${path}/`;
  const entries: DirectoryEntry[] = [];

  for (const [candidate, node] of files) {
    if (!candidate.startsWith(prefix) || candidate === path) {
      continue;
    }

    const remainder = candidate.slice(prefix.length);

    if (
      remainder === "" ||
      remainder.includes("/") ||
      (!includeHidden && remainder.startsWith("."))
    ) {
      continue;
    }

    entries.push({
      name: remainder,
      kind: node.kind,
      bytes: node.kind === "file" ? node.content.byteLength : 0,
    });
  }

  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

/** Builds the `ShellWorld` the shell's command set runs against. */
export function createShellWorld(options: ShellWorldOptions): ShellWorld {
  const files = options.files;

  return {
    cwd: options.cwd,
    fileInfo: (path) => {
      const node = files.get(path);

      return node === undefined
        ? undefined
        : node.kind === "file"
          ? { kind: "file", bytes: node.content.byteLength }
          : { kind: "dir" };
    },
    readFile: (path) => {
      const node = files.get(path);

      if (node === undefined) {
        throw new ShellIoError(`${path}: No such file or directory`);
      }

      if (node.kind !== "file") {
        throw new ShellIoError(`${path}: Is a directory`);
      }

      return node.content;
    },
    listDirectory: (path, includeHidden) => listEntries(files, path, includeHidden),
    writeFile: (path, content, append) => {
      const parent = dirname(path);
      const parentNode = files.get(parent);

      if (parentNode === undefined || parentNode.kind !== "dir") {
        throw new ShellIoError("No such file or directory");
      }

      const existing = files.get(path);

      if (existing !== undefined && existing.kind === "dir") {
        throw new ShellIoError("Is a directory");
      }

      const next =
        append && existing?.kind === "file"
          ? concat(existing.content, content)
          : new Uint8Array(content);
      files.set(path, { kind: "file", content: next });
    },
    makeDirectory: (path, recursive) => {
      if (path === "/") {
        return;
      }

      const existing = files.get(path);

      if (existing !== undefined) {
        if (existing.kind === "dir" && recursive) {
          return;
        }

        throw new ShellIoError("File exists");
      }

      const parent = dirname(path);
      const parentNode = files.get(parent);

      if (parentNode === undefined || parentNode.kind !== "dir") {
        if (recursive) {
          for (const ancestor of pathAncestors(path)) {
            files.set(ancestor, { kind: "dir" });
          }

          return;
        }

        throw new ShellIoError("No such file or directory");
      }

      files.set(path, { kind: "dir" });
    },
    remove: (path, recursive, force) => {
      const node = files.get(path);

      if (node === undefined) {
        if (force) {
          return;
        }

        throw new ShellIoError("No such file or directory");
      }

      if (path === "/") {
        throw new ShellIoError("refusing to remove the root directory");
      }

      // `rm` refuses a directory without `-r`, exactly as a real shell does,
      // so a tool that forgets the flag fails here and in a container alike.
      if (node.kind === "dir" && !recursive) {
        throw new ShellIoError("Is a directory");
      }

      for (const candidate of [...files.keys()]) {
        if (candidate === path || candidate.startsWith(`${path}/`)) {
          files.delete(candidate);
        }
      }
    },
    move: (from, to) => {
      const node = files.get(from);

      if (node === undefined) {
        throw new ShellIoError("No such file or directory");
      }

      const destination = files.get(to);
      const target = destination?.kind === "dir" ? `${to === "/" ? "" : to}/${basename(from)}` : to;

      if (target === from || target.startsWith(`${from}/`)) {
        throw new ShellIoError("cannot move a directory into itself");
      }

      if (destination !== undefined && destination.kind !== "dir" && node.kind === "dir") {
        throw new ShellIoError("File exists");
      }

      requireParentDirectory(files, target);

      for (const [path, candidate] of [...files.entries()]) {
        if (path === from || path.startsWith(`${from}/`)) {
          files.delete(path);
          files.set(`${target}${path.slice(from.length)}`, candidate);
        }
      }
    },
    copy: (from, to, recursive) => {
      const node = files.get(from);

      if (node === undefined) {
        throw new ShellIoError("No such file or directory");
      }

      if (node.kind === "dir" && !recursive) {
        throw new ShellIoError("Is a directory");
      }

      const destination = files.get(to);
      const target = destination?.kind === "dir" ? `${to === "/" ? "" : to}/${basename(from)}` : to;

      if (destination !== undefined && destination.kind !== "dir" && node.kind === "dir") {
        throw new ShellIoError("cannot overwrite non-directory with directory");
      }

      requireParentDirectory(files, target);

      for (const [path, candidate] of cloneNodes(files, from)) {
        const suffix = path === from ? "" : path.slice(from.length);
        files.set(`${target}${suffix}`, candidate);
      }
    },
    browser: options.browser,
  };
}
