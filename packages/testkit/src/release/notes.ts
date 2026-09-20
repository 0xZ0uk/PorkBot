/**
 * Release notes from the commit log (slice 11.7).
 *
 * A release's notes are generated, not written from memory: every commit since
 * the previous `desktop-v*` tag appears under the conventional-commit group it
 * declared, with its short hash so a reader can open it. Generating them from
 * the same log the artifact was built from is what keeps the notes and the
 * commit in one place, and it is why this is a pure function over `git log`
 * output rather than a file someone edits.
 */

interface NoteSection {
  readonly title: string;
  readonly types: readonly string[];
}

const sections: readonly NoteSection[] = [
  { title: "Features", types: ["feat"] },
  { title: "Fixes", types: ["fix"] },
  { title: "Performance", types: ["perf"] },
  { title: "Refactoring", types: ["refactor"] },
  { title: "Documentation", types: ["docs"] },
  { title: "Tests", types: ["test"] },
  { title: "Build and CI", types: ["build", "ci"] },
  { title: "Other changes", types: [] },
];

const commitPattern = /^([0-9a-f]{7,40})\t(.+)$/;

interface ParsedCommit {
  readonly hash: string;
  readonly description: string;
  readonly type: string | undefined;
}

function parseLog(log: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];

  for (const line of log.split("\n")) {
    const match = commitPattern.exec(line.trim());

    if (match === null) {
      continue;
    }

    const hash = match[1] ?? "";
    const subject = (match[2] ?? "").trim();
    const conventional = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.*)$/.exec(subject);

    commits.push({
      hash,
      description: conventional?.[2] ?? subject,
      type: conventional?.[1],
    });
  }

  return commits;
}

function capitalize(description: string): string {
  return description.length === 0
    ? description
    : `${description[0]?.toUpperCase()}${description.slice(1)}`;
}

function sectionFor(commit: ParsedCommit): string {
  for (const section of sections) {
    if (section.types.includes(commit.type ?? "")) {
      return section.title;
    }
  }

  return "Other changes";
}

export interface ReleaseNotesInput {
  readonly version: string;
  readonly ref: string;
  /** `git log --no-merges --pretty=format:%h%x09%s` output. */
  readonly log: string;
}

export function releaseNotesMarkdown(input: ReleaseNotesInput): string {
  const commits = parseLog(input.log);
  const grouped = new Map<string, ParsedCommit[]>();

  for (const commit of commits) {
    const title = sectionFor(commit);
    grouped.set(title, [...(grouped.get(title) ?? []), commit]);
  }

  const lines = [`## PorkBot desktop v${input.version}`, "", `Built from \`${input.ref}\`.`, ""];

  for (const section of sections) {
    const entries = grouped.get(section.title);

    if (entries === undefined || entries.length === 0) {
      continue;
    }

    lines.push(`### ${section.title}`, "");

    for (const entry of entries) {
      lines.push(`- ${capitalize(entry.description)} (\`${entry.hash}\`)`);
    }

    lines.push("");
  }

  if (commits.length === 0) {
    lines.push("No commits since the previous release.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
