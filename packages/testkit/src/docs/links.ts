import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The documentation's link check (slice 12.7). Markdown links and the
 * backticked `docs/...md` references the README uses are both pointers that
 * rot when a file moves; a heading anchor rots when a heading is reworded.
 * This module resolves both against the real tree so the `docs` CI tier fails
 * by name instead of a reader finding the 404.
 *
 * It reads files and nothing else, so the CI job needs no install.
 */

export interface MarkdownFile {
  /** Repo-relative path with POSIX separators (README.md, docs/backups.md). */
  readonly path: string;
  readonly text: string;
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/** The anchor slugs a document exposes, including GitHub's `-1` duplicates. */
export function headingSlugs(text: string): string[] {
  const seen = new Map<string, number>();
  const slugs: string[] = [];

  for (const line of linesOutsideFences(text)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);

    if (match === null) {
      continue;
    }

    const [, heading = ""] = match;
    const base = slugifyHeading(heading);

    if (base === "") {
      continue;
    }

    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.push(count === 0 ? base : `${base}-${count}`);
  }

  return slugs;
}

function linesOutsideFences(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const match = /^\s*(```|~~~)/.exec(line);

    if (match !== null) {
      fence = fence === null ? (match[1] ?? "```") : null;
      continue;
    }

    if (fence === null) {
      lines.push(line);
    }
  }

  return lines;
}

interface ExtractedLink {
  readonly target: string;
  readonly line: number;
}

/** Markdown links outside fenced code, with their 1-based line numbers. */
export function linksIn(text: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  let fence: string | null = null;

  text.split("\n").forEach((line, index) => {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);

    if (fenceMatch !== null) {
      fence = fence === null ? (fenceMatch[1] ?? "```") : null;
      return;
    }

    if (fence !== null) {
      return;
    }

    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const [, target = ""] = match;
      links.push({ target, line: index + 1 });
    }
  });

  return links;
}

function isExternal(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

function decode(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Problems with every relative markdown link, backticked `docs/...md`
 * reference and heading anchor in `files`. External URLs are ignored: this
 * check is about the repository's own tree, not the network.
 */
export function findLinkProblems(repoRoot: string, files: readonly MarkdownFile[]): string[] {
  const problems: string[] = [];
  const known = new Map(files.map((file) => [file.path, file.text]));

  const readMarkdown = (relative: string): string | undefined => {
    const inMemory = known.get(relative);

    if (inMemory !== undefined) {
      return inMemory;
    }

    if (!relative.endsWith(".md")) {
      return undefined;
    }

    const absolute = path.join(repoRoot, ...relative.split("/"));

    return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  };

  for (const file of files) {
    for (const { target, line } of linksIn(file.text)) {
      if (isExternal(target)) {
        continue;
      }

      const hash = target.indexOf("#");
      const rawPath = hash === -1 ? target : target.slice(0, hash);
      const fragment = hash === -1 ? "" : decode(target.slice(hash + 1));
      const resolved =
        rawPath === ""
          ? file.path
          : rawPath.startsWith("/")
            ? rawPath.slice(1)
            : path.posix.normalize(path.posix.join(path.posix.dirname(file.path), rawPath));

      if (resolved.startsWith("..")) {
        problems.push(`${file.path}:${String(line)}: link "${target}" escapes the repository.`);
        continue;
      }

      const absolute = path.join(repoRoot, ...resolved.split("/"));

      if (!existsSync(absolute)) {
        problems.push(
          `${file.path}:${String(line)}: link "${target}" points at ${resolved}, which does not exist.`,
        );
        continue;
      }

      if (fragment === "") {
        continue;
      }

      const targetText = readMarkdown(resolved);

      if (targetText === undefined) {
        continue;
      }

      if (!headingSlugs(targetText).includes(fragment)) {
        problems.push(
          `${file.path}:${String(line)}: link "${target}" names anchor "${fragment}", which ${resolved} does not have.`,
        );
      }
    }

    for (const match of file.text.matchAll(/`(docs\/[\w./-]+\.md)`/g)) {
      const [, reference = ""] = match;

      if (!existsSync(path.join(repoRoot, ...reference.split("/")))) {
        problems.push(
          `${file.path}: backticked reference "${reference}" points at a file that does not exist.`,
        );
      }
    }
  }

  const duplicateProblems = duplicateHeadingProblems(files);

  return [...problems, ...duplicateProblems];
}

/** A repeated heading makes its own anchor ambiguous, so it is a problem. */
export function duplicateHeadingProblems(files: readonly MarkdownFile[]): string[] {
  const problems: string[] = [];

  for (const file of files) {
    const counts = new Map<string, number>();

    for (const line of linesOutsideFences(file.text)) {
      const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);

      if (match === null) {
        continue;
      }

      const [, heading = ""] = match;
      const base = slugifyHeading(heading);

      if (base === "") {
        continue;
      }

      counts.set(base, (counts.get(base) ?? 0) + 1);
    }

    for (const [slug, count] of counts) {
      if (count > 1) {
        problems.push(
          `${file.path}: heading "${slug}" appears ${String(count)} times; merge the sections so the anchor is unambiguous.`,
        );
      }
    }
  }

  return problems;
}
