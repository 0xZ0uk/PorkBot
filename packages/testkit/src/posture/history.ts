import { execFileSync } from "node:child_process";
import {
  CONTENT_PERSONAL_DATA_RULES,
  PROSE_PERSONAL_DATA_RULES,
  findPersonalDataMatches,
  findSecretMatches,
  isPersonalEmail,
} from "./patterns.ts";
import type { PostureFinding } from "./finding.ts";

/**
 * The history half of the public-posture audit: everything reachable from the
 * published refs, checked as the three things a public repository leaks —
 * commit identities, commit prose and blob content.
 *
 * The scan is scoped to refs the audit is given (`refs/remotes` by default),
 * never to every object in the object database: a local clone also holds
 * dangling objects, agent checkpoints and history that was deliberately
 * rewritten, and failing on those would make the audit disagree with what a
 * fresh clone of the repository would see.
 */

const FIELD = "\u001f";
const RECORD = "\u001e";

// One batch is one `git cat-file` process. Chunking keeps a huge repository
// from building the content of every blob version in memory at once.
const blobBatchSize = 256;
const maximumBlobBytes = 4 * 1024 * 1024;
const gitBufferBytes = 1024 * 1024 * 1024;

export interface CommitRecord {
  readonly commit: string;
  readonly authorEmail: string;
  readonly committerEmail: string;
  readonly message: string;
}

export interface BlobRecord {
  readonly sha: string;
  readonly path: string;
}

export interface HistoryStats {
  readonly commits: number;
  readonly blobs: number;
  readonly bytes: number;
}

export interface HistoryScan {
  readonly findings: readonly PostureFinding[];
  readonly stats: HistoryStats;
}

function gitText(repoRoot: string, args: readonly string[], input?: string): string {
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
    maxBuffer: gitBufferBytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function gitBuffer(repoRoot: string, args: readonly string[], input: string): Buffer {
  // No `encoding`: node's default is a Buffer, and naming `"buffer"` as an
  // encoding string is rejected at runtime.
  return execFileSync("git", [...args], {
    cwd: repoRoot,
    input,
    maxBuffer: gitBufferBytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * The refs a fresh clone of the repository would have. Remote-tracking refs are
 * the published branches; a repository with no remote yet falls back to its
 * local heads, and a detached checkout with neither falls back to HEAD. Local
 * branches that were never pushed are deliberately out of scope: they are not
 * what a stranger clones, and auditing them would fail on a developer's stale
 * checkout rather than on the repository.
 */
function refsMatching(repoRoot: string, ...patterns: readonly string[]): string[] {
  return gitText(repoRoot, ["for-each-ref", "--format=%(refname)", ...patterns])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.endsWith("/HEAD"));
}

export function publishedRefs(repoRoot: string): string[] {
  const remote = refsMatching(repoRoot, "refs/remotes");

  if (remote.length > 0) {
    return remote;
  }

  const local = refsMatching(repoRoot, "refs/heads");

  return local.length > 0 ? local : ["HEAD"];
}

export function listCommits(repoRoot: string, refs: readonly string[]): CommitRecord[] {
  if (refs.length === 0) {
    return [];
  }

  const format = ["%H", "%ae", "%ce", "%B"].join(FIELD) + RECORD;
  const output = gitText(repoRoot, ["log", `--format=${format}`, ...refs]);

  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [commit = "", authorEmail = "", committerEmail = "", ...message] = record.split(FIELD);

      return {
        commit,
        authorEmail: authorEmail.trim(),
        committerEmail: committerEmail.trim(),
        message: message.join(FIELD),
      };
    });
}

export function listBlobs(repoRoot: string, refs: readonly string[]): BlobRecord[] {
  if (refs.length === 0) {
    return [];
  }

  const listed = gitText(repoRoot, ["rev-list", "--objects", ...refs]);
  const checked = gitText(
    repoRoot,
    ["cat-file", "--batch-check=%(objecttype) %(objectname) %(rest)"],
    listed,
  );

  const seen = new Set<string>();
  const blobs: BlobRecord[] = [];

  for (const line of checked.split("\n")) {
    if (!line.startsWith("blob ")) {
      continue;
    }

    const [, sha = "", ...rest] = line.split(" ");
    const blobPath = rest.join(" ");

    if (blobPath === "" || seen.has(sha)) {
      continue;
    }

    seen.add(sha);
    blobs.push({ sha, path: blobPath });
  }

  return blobs;
}

interface BlobContent {
  readonly sha: string;
  readonly bytes: Buffer;
}

function readBlobs(repoRoot: string, shas: readonly string[]): BlobContent[] {
  if (shas.length === 0) {
    return [];
  }

  const output = gitBuffer(repoRoot, ["cat-file", "--batch"], `${shas.join("\n")}\n`);
  const contents: BlobContent[] = [];
  let offset = 0;

  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);

    if (newline === -1) {
      break;
    }

    const [sha = "", type = "", sizeText = "0"] = output
      .subarray(offset, newline)
      .toString("utf8")
      .split(" ");
    const size = Number.parseInt(sizeText, 10);
    const start = newline + 1;
    const end = start + size;

    if (type === "blob" && Number.isFinite(size)) {
      contents.push({ sha, bytes: output.subarray(start, end) });
    }

    offset = end + 1;
  }

  return contents;
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

function scanBlob(blob: BlobRecord, bytes: Buffer): PostureFinding[] {
  const text = bytes.toString("utf8");
  const subject = `blob ${blob.path} (${blob.sha.slice(0, 12)})`;
  const findings: PostureFinding[] = [];

  for (const match of findSecretMatches(text)) {
    findings.push({ kind: "secret", ...match, subject });
  }

  for (const match of findPersonalDataMatches(text, CONTENT_PERSONAL_DATA_RULES)) {
    findings.push({ kind: "personal-data", ...match, subject });
  }

  return findings;
}

export function scanHistory(repoRoot: string, refs: readonly string[]): HistoryScan {
  const findings: PostureFinding[] = [];
  const commits = listCommits(repoRoot, refs);

  for (const record of commits) {
    const subject = `commit ${record.commit.slice(0, 12)}`;

    for (const [role, email] of [
      ["author", record.authorEmail],
      ["committer", record.committerEmail],
    ] as const) {
      if (isPersonalEmail(email)) {
        findings.push({
          kind: "personal-data",
          rule: "personal/email",
          subject: `${subject} ${role} identity`,
          summary: "an email address that is not a reserved example domain",
        });
      }
    }

    for (const match of findPersonalDataMatches(record.message, PROSE_PERSONAL_DATA_RULES)) {
      findings.push({ kind: "prose", ...match, subject: `${subject} message` });
    }
  }

  const blobs = listBlobs(repoRoot, refs);
  let bytes = 0;
  let scanned = 0;

  for (let start = 0; start < blobs.length; start += blobBatchSize) {
    const batch = blobs.slice(start, start + blobBatchSize);
    const bySha = new Map(batch.map((blob) => [blob.sha, blob]));

    for (const content of readBlobs(
      repoRoot,
      batch.map((blob) => blob.sha),
    )) {
      const blob = bySha.get(content.sha);

      if (
        blob === undefined ||
        content.bytes.length > maximumBlobBytes ||
        isBinary(content.bytes)
      ) {
        continue;
      }

      bytes += content.bytes.length;
      scanned += 1;
      findings.push(...scanBlob(blob, content.bytes));
    }
  }

  return {
    findings,
    stats: { commits: commits.length, blobs: scanned, bytes },
  };
}
