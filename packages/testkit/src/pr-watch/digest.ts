import type { CheckRun, IssueComment, PrWatchClient, Review, ReviewComment } from "./github.ts";
import { failingConclusion, pendingCount, pendingNames } from "./watch.ts";

/**
 * The digest is the observation a verdict is taken on. It reads the PR's meta,
 * the checks and statuses attached to one head SHA, and the review surfaces,
 * prints what needs a decision, and ends in one `VERDICT` line with a matching
 * exit code. Every statement it makes is tied to a commit, and it re-reads the
 * head at the end: if the head moved while it was reading, the verdict is
 * `out-of-sync` and the caller must observe again rather than trust a mix of
 * two commits.
 */

export type Verdict =
  | "green"
  | "failures"
  | "open-comments"
  | "pending"
  | "out-of-sync"
  | "draft"
  | "merged"
  | "closed";

export const exitCodes: Readonly<Record<Verdict, number>> = {
  green: 0,
  failures: 10,
  "open-comments": 11,
  pending: 12,
  draft: 13,
  "out-of-sync": 20,
  merged: 0,
  closed: 0,
};

export interface GitState {
  readonly branch: string | null;
  readonly head: string | null;
  readonly upstream: string | null;
}

export interface DigestOptions {
  readonly viewer: string;
  readonly git: GitState;
  readonly bodyChars?: number;
}

export interface Digest {
  readonly lines: readonly string[];
  readonly verdict: Verdict;
  readonly exitCode: number;
}

export interface OpenFinding {
  readonly id: number;
  readonly author: string;
  readonly location: string;
  readonly body: string;
}

// Sticky bot output that carries no finding: summaries, rate-limit notices and
// screenshot galleries. Actionable bot comments are not noise and must still
// block green.
const noisePrefixes: readonly (readonly [string, string])[] = [
  ["coderabbitai[bot]", "<!-- This is an auto-generated comment: summarize"],
  ["coderabbitai[bot]", "<!-- This is an auto-generated comment: rate limited"],
  ["greptile-apps[bot]", "<h3>Greptile Summary</h3>"],
  ["github-actions[bot]", "<!-- porkbot-playwright-screenshots -->"],
];

function isNoise(comment: IssueComment): boolean {
  return noisePrefixes.some(
    ([author, prefix]) => comment.author === author && comment.body.startsWith(prefix),
  );
}

/**
 * Review bots pad bodies with collapsed sections, HTML markers and badge
 * images; the prose around them is the whole finding. Details blocks are
 * removed from the inside out before tags are stripped, because cutting at the
 * first `<details>` drops the prose after it.
 */
export function cleanBody(raw: string, maxChars: number): string {
  let text = raw.replace(/<!--[\s\S]*?-->/g, "");

  for (let pass = 0; pass < 6; pass += 1) {
    text = text.replace(/<details>(?:(?!<details>)[\s\S])*?<\/details>/g, "");
  }

  text = text
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");

  const printable = [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("");

  return printable.trim().slice(0, maxChars).trim();
}

/**
 * Complete URL tokens only, never substrings or bare ids: a reply counts as
 * answering a conversation comment only when it links that comment's permalink.
 */
export function linksTo(body: string, url: string): boolean {
  const tokens = body.match(/https?:\/\/[^\s<>"'()[\]]+/g) ?? [];

  return tokens.map((token) => token.replace(/[.,;:!?]+$/, "")).includes(url);
}

function latestReviewPerAuthor(reviews: readonly Review[]): readonly Review[] {
  const sorted = [...reviews].sort(
    (left, right) =>
      (left.submittedAt ?? "").localeCompare(right.submittedAt ?? "") || left.id - right.id,
  );
  const latest = new Map<string, Review>();

  for (const review of sorted) {
    if (
      review.state === "APPROVED" ||
      review.state === "CHANGES_REQUESTED" ||
      review.state === "DISMISSED"
    ) {
      latest.set(review.author, review);
    }
  }

  return [...latest.values()];
}

export function openFindings(
  inline: readonly ReviewComment[],
  conversation: readonly IssueComment[],
  reviews: readonly Review[],
  viewer: string,
  bodyChars: number,
): readonly OpenFinding[] {
  const findings: OpenFinding[] = [];

  const myReplies = inline.filter(
    (comment) => comment.inReplyToId !== null && comment.author === viewer,
  );

  for (const root of inline) {
    if (root.inReplyToId !== null || root.author === viewer) {
      continue;
    }

    const answered = myReplies.some(
      (reply) => reply.inReplyToId === root.id && reply.createdAt > root.updatedAt,
    );

    if (!answered) {
      findings.push({
        id: root.id,
        author: root.author,
        location: `${root.path}:${root.line ?? "?"}`,
        body: cleanBody(root.body, bodyChars),
      });
    }
  }

  const myConversation = conversation.filter((comment) => comment.author === viewer);

  for (const comment of conversation) {
    if (comment.author === viewer || isNoise(comment)) {
      continue;
    }

    const answered = myConversation.some(
      (reply) => reply.createdAt > comment.updatedAt && linksTo(reply.body, comment.htmlUrl),
    );

    if (!answered) {
      findings.push({
        id: comment.id,
        author: comment.author,
        location: "(conversation)",
        body: cleanBody(comment.body, bodyChars),
      });
    }
  }

  for (const review of latestReviewPerAuthor(reviews)) {
    if (review.author === viewer) {
      continue;
    }

    if (review.state === "CHANGES_REQUESTED" && review.body.trim() !== "") {
      findings.push({
        id: review.id,
        author: review.author,
        location: `(review ${review.state})`,
        body: cleanBody(review.body, bodyChars),
      });
    }
  }

  return findings;
}

export function reviewSignalsOnHead(
  inline: readonly ReviewComment[],
  reviews: readonly Review[],
  head: string,
): readonly string[] {
  const signals = new Set<string>();

  for (const review of reviews) {
    if (review.commitId === head) {
      signals.add(review.author);
    }
  }

  for (const comment of inline) {
    if (comment.commitId === head && comment.inReplyToId === null) {
      signals.add(comment.author);
    }
  }

  return [...signals];
}

function shortSha(sha: string | null): string {
  return sha === null || sha === "" ? "none" : sha.slice(0, 8);
}

function jobIdFromUrl(url: string): string | null {
  return /\/job\/(\d+)/.exec(url)?.[1] ?? null;
}

function stepSuffix(client: PrWatchClient, run: CheckRun): string {
  const jobId = jobIdFromUrl(run.url);

  if (jobId === null) {
    return "";
  }

  try {
    const job = client.job(jobId);
    const bad = job.steps.find(
      (step) => step.conclusion === "failure" || step.conclusion === "cancelled",
    );

    if (bad === undefined) {
      return "";
    }

    const laterSkipped = job.steps.some(
      (step) => step.number > bad.number && step.conclusion === "skipped",
    );

    return ` · step "${bad.name}" ${bad.conclusion ?? "failed"}${
      laterSkipped ? " (later steps skipped)" : ""
    }`;
  } catch {
    // A check run is not always an Actions job; a missing step is not a verdict.
    return "";
  }
}

export function buildDigest(client: PrWatchClient, pr: number, options: DigestOptions): Digest {
  const lines: string[] = [];
  const bodyChars = options.bodyChars ?? 600;
  const meta = client.pullMeta(pr);
  const head = meta.headRefOid;

  lines.push(
    `PR ${meta.number} · ${meta.headRefName} · ${meta.state} · ${meta.mergeable}` +
      (meta.reviewDecision === null ? "" : ` · ${meta.reviewDecision}`) +
      (meta.isDraft ? " · draft" : ""),
  );
  lines.push(`HEAD ${head}`);

  if (meta.state !== "OPEN") {
    const verdict: Verdict = meta.state.toLowerCase() === "merged" ? "merged" : "closed";
    lines.push(`VERDICT ${verdict}`);
    return { lines, verdict, exitCode: exitCodes[verdict] };
  }

  const onBranch = options.git.branch !== null && options.git.branch === meta.headRefName;
  const outOfSync =
    onBranch &&
    ((options.git.head !== null && options.git.head !== head) ||
      (options.git.upstream !== null && options.git.upstream !== head));

  if (outOfSync) {
    lines.push(
      `OUT OF SYNC local=${shortSha(options.git.head)} upstream=${shortSha(
        options.git.upstream,
      )} pr=${shortSha(head)}`,
    );
  }

  const runs = client.checkRuns(head);
  const statuses = client.commitStatuses(head);
  const pending = pendingCount(runs, statuses);
  const failing = runs.filter((run) => failingConclusion(run.conclusion));
  const failingStatuses = statuses.filter(
    (status) => status.state === "failure" || status.state === "error",
  );
  const passed = runs.filter((run) => run.conclusion === "success").length;

  lines.push(
    `checks ${runs.length} total · ${passed} success · ${pending} pending · ${
      failing.length + failingStatuses.length
    } failure`,
  );

  const waiting = pendingNames(runs, statuses);

  if (waiting.length > 0) {
    lines.push(`pending ${waiting.join(", ")}`);
  }

  for (const run of failing) {
    lines.push(
      `FAIL ${run.name} [${run.conclusion ?? "failure"}]${stepSuffix(client, run)} · ${
        run.url === "" ? "no url" : run.url
      }`,
    );
  }

  for (const status of failingStatuses) {
    lines.push(`STATUS ${status.context} ${status.state}`);
  }

  const inline = client.reviewComments(pr);
  const conversation = client.conversationComments(pr);
  const reviews = client.reviews(pr);
  const open = openFindings(inline, conversation, reviews, options.viewer, bodyChars);
  const noise = conversation.filter(isNoise).length;

  lines.push(
    `comments ${inline.length} inline · ${conversation.length} conversation (${noise} noise) · ${
      reviews.length
    } reviews · ${open.length} awaiting your reply`,
  );

  for (const finding of open) {
    lines.push(`[${finding.id}] ${finding.author} ${finding.location}`);
    lines.push(`  ${finding.body}`);
  }

  if (meta.reviewDecision === "CHANGES_REQUESTED") {
    lines.push("REVIEW changes requested");
  }

  const signals = reviewSignalsOnHead(inline, reviews, head);

  lines.push(
    signals.length > 0
      ? `review-bots ${signals.length} signal(s) on ${shortSha(head)}: ${signals.join(", ")}`
      : `review-bots no signal on ${shortSha(head)} yet`,
  );

  // A verdict describes one commit. If the head moved while we were reading,
  // everything above may already be stale, so the caller observes again.
  const headNow = client.pullMeta(pr).headRefOid;

  if (headNow !== head) {
    lines.push(`HEAD moved during observation: ${shortSha(head)} -> ${shortSha(headNow)}`);
    lines.push("VERDICT out-of-sync");
    return { lines, verdict: "out-of-sync", exitCode: 20 };
  }

  let verdict: Verdict;

  if (outOfSync) {
    verdict = "out-of-sync";
  } else if (failing.length > 0 || failingStatuses.length > 0) {
    verdict = "failures";
  } else if (open.length > 0 || meta.reviewDecision === "CHANGES_REQUESTED") {
    verdict = "open-comments";
  } else if (pending > 0) {
    verdict = "pending";
  } else if (meta.isDraft) {
    verdict = "draft";
  } else {
    verdict = "green";
  }

  lines.push(
    verdict === "pending" && pending > 0
      ? `VERDICT pending (${pending} pending)`
      : `VERDICT ${verdict}`,
  );

  return { lines, verdict, exitCode: exitCodes[verdict] };
}
