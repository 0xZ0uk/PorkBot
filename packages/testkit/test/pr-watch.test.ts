import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { refusedRerunExitCode, runCli } from "../src/pr-watch/commands.ts";
import type { RunDeps } from "../src/pr-watch/commands.ts";
import { buildDigest } from "../src/pr-watch/digest.ts";
import type { GitState } from "../src/pr-watch/digest.ts";
import { classifyFailure, logExcerpt, stripLog } from "../src/pr-watch/failure.ts";
import { createGhClient } from "../src/pr-watch/github.ts";
import type {
  CheckRun,
  CommitStatus,
  IssueComment,
  JobDetail,
  PrWatchClient,
  PullMeta,
  Review,
  ReviewComment,
} from "../src/pr-watch/github.ts";
import { waitForTerminalHead } from "../src/pr-watch/watch.ts";
import type { HeadObservation } from "../src/pr-watch/watch.ts";

/**
 * The tests behind AGENTS.md's promise that a failing job is never rerun
 * before the failure is shown unrelated, and that a verdict is only ever taken
 * on the current head SHA. The GitHub client is a scripted object here; the
 * concrete `gh` plumbing is tested separately against canned JSON.
 */

const head = "0123456789abcdef0123456789abcdef01234567";
const secondHead = "fedcba9876543210fedcba9876543210fedcba98";
const cleanGit: GitState = { branch: null, head: null, upstream: null };
const viewer = "porkbot-agent";

function meta(overrides: Partial<PullMeta> = {}): PullMeta {
  return {
    number: 22,
    state: "OPEN",
    headRefOid: head,
    headRefName: "agent/agents-pr-watch-0918a",
    baseRefName: "main",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    isDraft: false,
    ...overrides,
  };
}

function checkRun(name: string, status: string, conclusion: string | null, url = ""): CheckRun {
  return { name, status, conclusion, url };
}

function commitStatus(context: string, state: string): CommitStatus {
  return { context, state };
}

function failingJob(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 99,
    runId: 4242,
    name: "unit",
    conclusion: "failure",
    htmlUrl: "https://example.test/actions/runs/1/job/99",
    steps: [{ name: "Unit tests with coverage", number: 1, conclusion: "failure" }],
    ...overrides,
  };
}

interface FakeClientOptions {
  readonly meta?: () => PullMeta;
  readonly runs?: () => readonly CheckRun[];
  readonly statuses?: () => readonly CommitStatus[];
  readonly inline?: () => readonly ReviewComment[];
  readonly conversation?: () => readonly IssueComment[];
  readonly reviews?: () => readonly Review[];
  readonly job?: JobDetail;
  readonly log?: string;
}

interface FakeClient extends PrWatchClient {
  readonly reruns: number[];
  readonly replies: Array<{ id: number; body: string }>;
}

function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const reruns: number[] = [];
  const replies: Array<{ id: number; body: string }> = [];

  return {
    reruns,
    replies,
    repo: () => "0xZ0uk/PorkBot",
    viewer: () => viewer,
    resolvePull: () => 22,
    pullMeta: options.meta ?? (() => meta()),
    checkRuns: options.runs ?? (() => []),
    commitStatuses: options.statuses ?? (() => []),
    reviewComments: options.inline ?? (() => []),
    conversationComments: options.conversation ?? (() => []),
    reviews: options.reviews ?? (() => []),
    job: () => options.job ?? failingJob(),
    jobLog: () => options.log ?? "",
    rerunFailed: (runId) => {
      reruns.push(runId);
    },
    replyToReviewComment: (id, body) => {
      replies.push({ id, body });
    },
  };
}

interface Harness {
  readonly client: FakeClient;
  readonly deps: RunDeps;
  readonly out: string[];
  readonly err: string[];
}

function harness(
  client: FakeClient = fakeClient(),
  env: Record<string, string | undefined> = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  let time = 0;

  return {
    client,
    out,
    err,
    deps: {
      client,
      io: {
        out: (line) => {
          out.push(line);
        },
        err: (line) => {
          err.push(line);
        },
      },
      env,
      git: cleanGit,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  };
}

function digestOf(client: PrWatchClient, git: GitState = cleanGit) {
  return buildDigest(client, 22, { viewer, git });
}

const assertionLog = [
  "unit\tUnit tests\t2026-09-18T00:00:00.0000000Z FAIL  src/index.test.ts > adds two numbers",
  "unit\tUnit tests\t2026-09-18T00:00:00.0000000Z AssertionError: expected 1 to be 2",
  "unit\tUnit tests\t2026-09-18T00:00:00.0000000Z  ❯ src/index.test.ts:10:5",
].join("\n");

const infrastructureLog = [
  "unit\tSetup pnpm\t2026-09-18T00:00:00.0000000Z Error: Failed to resolve action download info. Error: Service Unavailable",
].join("\n");

describe("waitForTerminalHead", () => {
  it("blocks while the head's checks are pending and returns when they are terminal", async () => {
    let calls = 0;
    const client = fakeClient({
      runs: () =>
        calls++ === 0
          ? [checkRun("unit", "in_progress", null)]
          : [checkRun("unit", "completed", "success")],
    });
    const seen: HeadObservation[] = [];
    let time = 0;
    const result = await waitForTerminalHead(client, 22, {
      pollMs: 5,
      deadlineMs: 1000,
      emptyPolls: 3,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      onObservation: (observation) => {
        seen.push(observation);
      },
    });

    expect(calls).toBe(2);
    expect(result.pending).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.head).toBe(head);
    expect(seen.map((observation) => observation.pending)).toEqual([1]);
    expect(seen.every((observation) => observation.head === head)).toBe(true);
  });

  it("restarts the observation when the head moves, never mixing two commits", async () => {
    let metaCalls = 0;
    let runCalls = 0;
    const client = fakeClient({
      meta: () => meta({ headRefOid: metaCalls++ === 0 ? head : secondHead }),
      runs: () =>
        runCalls++ === 0
          ? [checkRun("unit", "queued", null)]
          : [checkRun("unit", "completed", "success")],
    });
    const seen: HeadObservation[] = [];
    let time = 0;
    const result = await waitForTerminalHead(client, 22, {
      pollMs: 5,
      deadlineMs: 1000,
      emptyPolls: 3,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      onObservation: (observation) => {
        seen.push(observation);
      },
    });

    expect(result.head).toBe(secondHead);
    expect(result.pending).toBe(0);
    expect(seen.map((observation) => observation.head)).toEqual([head]);
    expect(seen.every((observation) => observation.head !== secondHead)).toBe(true);
  });

  it("stops at the deadline and reports the pending state", async () => {
    const client = fakeClient({
      runs: () => [checkRun("unit", "in_progress", null)],
      statuses: () => [commitStatus("legacy/check", "pending")],
    });
    let time = 0;
    const result = await waitForTerminalHead(client, 22, {
      pollMs: 10,
      deadlineMs: 25,
      emptyPolls: 3,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });

    expect(result.timedOut).toBe(true);
    expect(result.pending).toBe(2);
  });

  it("does not mistake a fresh PR with no checks for a terminal one", async () => {
    let calls = 0;
    const client = fakeClient({
      runs: () => {
        calls += 1;
        return [];
      },
    });
    let time = 0;
    const result = await waitForTerminalHead(client, 22, {
      pollMs: 1,
      deadlineMs: 1000,
      emptyPolls: 2,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });

    expect(calls).toBe(3);
    expect(result.pending).toBe(0);
    expect(result.emptyTerminal).toBe(true);
  });
});

describe("digest", () => {
  it("reports a failed job with the step that broke", () => {
    const client = fakeClient({
      runs: () => [
        checkRun("unit", "completed", "failure", "https://example.test/actions/runs/1/job/99"),
      ],
      job: failingJob({
        steps: [
          { name: "Install", number: 1, conclusion: "success" },
          { name: "Unit tests with coverage", number: 2, conclusion: "failure" },
          { name: "Coverage summary", number: 3, conclusion: "skipped" },
        ],
      }),
    });
    const result = digestOf(client);
    const text = result.lines.join("\n");

    expect(result.exitCode).toBe(10);
    expect(text).toContain("VERDICT failures");
    expect(text).toContain("FAIL unit [failure]");
    expect(text).toContain('step "Unit tests with coverage"');
    expect(text).toContain("(later steps skipped)");
  });

  it("reports pending checks and exits pending", () => {
    const client = fakeClient({
      runs: () => [
        checkRun("unit", "in_progress", null),
        checkRun("build", "completed", "success"),
      ],
    });
    const result = digestOf(client);

    expect(result.exitCode).toBe(12);
    expect(result.lines.join("\n")).toContain("VERDICT pending (1 pending)");
    expect(result.lines.join("\n")).toContain("pending unit");
  });

  it("is green when every check is terminal and no finding is open", () => {
    const client = fakeClient({ runs: () => [checkRun("unit", "completed", "success")] });
    const result = digestOf(client);

    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("VERDICT green");
  });

  it("keeps an inline review finding open until the viewer replies after it was updated", () => {
    const root: ReviewComment = {
      id: 5,
      author: "coderabbitai[bot]",
      body: "Please use the token",
      path: "packages/ui/src/button.tsx",
      line: 12,
      createdAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T00:00:00Z",
      inReplyToId: null,
      commitId: head,
    };
    const open = digestOf(fakeClient({ inline: () => [root] }));
    expect(open.exitCode).toBe(11);
    expect(open.lines.join("\n")).toContain("[5] coderabbitai[bot] packages/ui/src/button.tsx:12");

    const reply: ReviewComment = {
      id: 6,
      author: viewer,
      body: "Fixed in the next push",
      path: "packages/ui/src/button.tsx",
      line: 12,
      createdAt: "2026-09-18T01:00:00Z",
      updatedAt: "2026-09-18T01:00:00Z",
      inReplyToId: 5,
      commitId: head,
    };
    const answered = digestOf(fakeClient({ inline: () => [root, reply] }));
    expect(answered.exitCode).toBe(0);

    const edited: ReviewComment = { ...root, updatedAt: "2026-09-18T02:00:00Z" };
    const reopened = digestOf(fakeClient({ inline: () => [edited, reply] }));
    expect(reopened.exitCode).toBe(11);
  });

  it("treats a conversation comment as open until a viewer reply links its permalink", () => {
    const comment: IssueComment = {
      id: 7,
      author: "github-copilot[bot]",
      body: "Consider covering the refusal path",
      createdAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T00:00:00Z",
      htmlUrl: "https://github.com/0xZ0uk/PorkBot/pull/22#issuecomment-7",
    };
    const open = digestOf(fakeClient({ conversation: () => [comment] }));
    expect(open.exitCode).toBe(11);

    const unlinked: IssueComment = {
      ...comment,
      id: 8,
      author: viewer,
      body: "Done",
      createdAt: "2026-09-18T01:00:00Z",
    };
    expect(digestOf(fakeClient({ conversation: () => [comment, unlinked] })).exitCode).toBe(11);

    const linked: IssueComment = {
      ...unlinked,
      body: "Done: https://github.com/0xZ0uk/PorkBot/pull/22#issuecomment-7",
    };
    expect(digestOf(fakeClient({ conversation: () => [comment, linked] })).exitCode).toBe(0);
  });

  it("ignores sticky bot summaries but not actionable bot comments", () => {
    const summary: IssueComment = {
      id: 9,
      author: "coderabbitai[bot]",
      body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\nAll good.",
      createdAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T00:00:00Z",
      htmlUrl: "https://github.com/0xZ0uk/PorkBot/pull/22#issuecomment-9",
    };
    expect(digestOf(fakeClient({ conversation: () => [summary] })).exitCode).toBe(0);

    const actionable: IssueComment = { ...summary, id: 10, body: "This branch is wrong." };
    expect(digestOf(fakeClient({ conversation: () => [actionable] })).exitCode).toBe(11);
  });

  it("blocks green while a reviewer requests changes and clears on a later approval", () => {
    const changes: Review = {
      id: 1,
      author: "reviewer",
      state: "CHANGES_REQUESTED",
      body: "Please split this slice",
      submittedAt: "2026-09-18T00:00:00Z",
      commitId: head,
    };
    const requested = digestOf(
      fakeClient({
        reviews: () => [changes],
        meta: () => meta({ reviewDecision: "CHANGES_REQUESTED" }),
      }),
    );
    expect(requested.exitCode).toBe(11);
    expect(requested.lines.join("\n")).toContain("REVIEW changes requested");

    const approval: Review = {
      ...changes,
      id: 2,
      state: "APPROVED",
      body: "Looks good",
      submittedAt: "2026-09-18T01:00:00Z",
    };
    const decision = meta({ reviewDecision: "CHANGES_REQUESTED" });
    expect(
      digestOf(fakeClient({ reviews: () => [changes, approval], meta: () => decision })).verdict,
    ).toBe("open-comments");
    expect(digestOf(fakeClient({ reviews: () => [changes, approval] })).exitCode).toBe(0);
  });

  it("reports the review signals seen on the head commit", () => {
    const review: Review = {
      id: 3,
      author: "coderabbitai[bot]",
      state: "COMMENTED",
      body: "",
      submittedAt: "2026-09-18T00:00:00Z",
      commitId: head,
    };
    const onHead = digestOf(fakeClient({ reviews: () => [review] }));
    expect(onHead.lines.join("\n")).toContain(
      "review-bots 1 signal(s) on 01234567: coderabbitai[bot]",
    );

    const onEarlier = digestOf(
      fakeClient({ reviews: () => [{ ...review, commitId: secondHead }] }),
    );
    expect(onEarlier.lines.join("\n")).toContain("review-bots no signal on 01234567 yet");
  });

  it("reports an out-of-sync checkout", () => {
    const git: GitState = {
      branch: "agent/agents-pr-watch-0918a",
      head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      upstream: head,
    };
    const result = digestOf(fakeClient(), git);

    expect(result.exitCode).toBe(20);
    expect(result.lines.join("\n")).toContain("OUT OF SYNC");
  });

  it("never returns a verdict for a head that moved while it was reading", () => {
    let calls = 0;
    const client = fakeClient({
      meta: () => meta({ headRefOid: calls++ === 0 ? head : secondHead }),
      runs: () => [checkRun("unit", "completed", "success")],
    });
    const result = digestOf(client);

    expect(result.exitCode).toBe(20);
    expect(result.lines.join("\n")).toContain("HEAD moved during observation");
    expect(result.lines.join("\n")).toContain("VERDICT out-of-sync");
  });

  it("refuses a draft", () => {
    const client = fakeClient({ meta: () => meta({ isDraft: true }) });
    expect(digestOf(client).exitCode).toBe(13);
  });
});

describe("failure classification", () => {
  it("classifies an assertion failure", () => {
    const classification = classifyFailure(assertionLog);
    expect(classification.kind).toBe("assertion");
    expect(classification.evidence.length).toBeGreaterThan(0);
  });

  it("classifies an infrastructure failure", () => {
    const classification = classifyFailure(infrastructureLog);
    expect(classification.kind).toBe("infrastructure");
    expect(classification.evidence[0]).toContain("Failed to resolve action download");
  });

  it("calls an unrecognised failure unknown", () => {
    expect(classifyFailure("unit\tStep\t2026-09-18T00:00:00Z something odd happened").kind).toBe(
      "unknown",
    );
  });

  it("prefers the assertion reading when a log matches both", () => {
    const mixed = `${infrastructureLog}\n${assertionLog}`;
    expect(classifyFailure(mixed).kind).toBe("assertion");
  });

  it("strips the job, step and timestamp prefix and ANSI colour", () => {
    const raw = `unit\tStep\t2026-09-18T00:00:00.0000000Z \u001b[31mFAIL\u001b[0m src/a.test.ts`;
    expect(stripLog(raw)).toBe("FAIL src/a.test.ts");
  });

  it("keeps the interesting lines of a log and collapses repeated errors", () => {
    const raw = [
      "unit\tStep\t2026-09-18T00:00:00Z noise noise noise",
      "unit\tStep\t2026-09-18T00:00:00Z  1 failed | 2 passed",
      "unit\tStep\t2026-09-18T00:00:00Z ##[error]Process completed with exit code 1.",
      "unit\tStep\t2026-09-18T00:00:00Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    const excerpt = logExcerpt(raw);

    expect(excerpt).toContain("1 failed | 2 passed");
    expect(excerpt.match(/##\[error\]/g)).toHaveLength(1);
    expect(excerpt).not.toContain("noise noise noise");
  });
});

describe("rerun guard", () => {
  it("refuses to rerun an assertion failure with no proof", async () => {
    const client = fakeClient({ job: failingJob(), log: assertionLog });
    const { deps, err } = harness(client);

    const code = await runCli(["--rerun", "99"], deps);

    expect(code).toBe(refusedRerunExitCode);
    expect(client.reruns).toEqual([]);
    expect(err.join("\n")).toContain("refusing to rerun");
  });

  it("reruns an infrastructure failure on its own evidence", async () => {
    const client = fakeClient({ job: failingJob(), log: infrastructureLog });
    const { deps, out } = harness(client);

    const code = await runCli(["--rerun", "99"], deps);

    expect(code).toBe(0);
    expect(client.reruns).toEqual([4242]);
    expect(out.join("\n")).toContain("basis=infrastructure");
  });

  it("reruns with a recorded base-revision reproduction", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pr-watch-"));
    const evidence = path.join(directory, "evidence.txt");
    writeFileSync(evidence, "base revision: reproduced `pnpm test` failing in unit the same way\n");
    const client = fakeClient({ job: failingJob(), log: assertionLog });
    const { deps, out } = harness(client);

    const code = await runCli(["--rerun", "99", "--evidence", evidence], deps);

    expect(code).toBe(0);
    expect(client.reruns).toEqual([4242]);
    expect(out.join("\n")).toContain(`evidence ${evidence}`);
  });

  it("refuses an empty evidence file", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pr-watch-"));
    const evidence = path.join(directory, "empty.txt");
    writeFileSync(evidence, "   \n");
    const client = fakeClient({ job: failingJob(), log: assertionLog });
    const { deps, err } = harness(client);

    const code = await runCli(["--rerun", "99", "--evidence", evidence], deps);

    expect(code).toBe(1);
    expect(client.reruns).toEqual([]);
    expect(err.join("\n")).toContain("empty");
  });

  it("refuses to rerun a job that is not failing", async () => {
    const client = fakeClient({
      job: failingJob({ conclusion: "success" }),
      log: infrastructureLog,
    });
    const { deps, err } = harness(client);

    expect(await runCli(["--rerun", "99"], deps)).toBe(1);
    expect(client.reruns).toEqual([]);
    expect(err.join("\n")).toContain("not failing");
  });

  it("classifies a job without rerunning it", async () => {
    const client = fakeClient({ job: failingJob(), log: infrastructureLog });
    const { deps, out } = harness(client);

    expect(await runCli(["--classify", "99"], deps)).toBe(0);
    expect(out.join("\n")).toContain("CLASS infrastructure");
    expect(client.reruns).toEqual([]);
  });
});

describe("watch command", () => {
  it("only digests after the head is terminal and exits with its verdict", async () => {
    let calls = 0;
    const client = fakeClient({
      runs: () =>
        calls++ === 0
          ? [checkRun("unit", "in_progress", null)]
          : [checkRun("unit", "completed", "success")],
    });
    const { deps, out } = harness(client, {
      PR_WATCH_POLL_MS: "1",
      PR_WATCH_DEADLINE_MS: "1000",
    });

    const code = await runCli(["--watch"], deps);
    const text = out.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("waiting 01234567 · 1 pending (unit)");
    expect(text).toContain("VERDICT green");
  });

  it("reports pending, not green, when the deadline passes with no checks registered", async () => {
    const client = fakeClient();
    const { deps, out } = harness(client, {
      PR_WATCH_POLL_MS: "5",
      PR_WATCH_DEADLINE_MS: "10",
      PR_WATCH_EMPTY_POLLS: "100",
    });

    const code = await runCli(["--watch"], deps);

    expect(code).toBe(12);
    expect(out.join("\n")).toContain("timed out");
    expect(out.join("\n")).toContain("VERDICT pending");
  });
});

describe("merge gate", () => {
  it("refuses to bless a merge while a finding is open", async () => {
    const root: ReviewComment = {
      id: 5,
      author: "coderabbitai[bot]",
      body: "Please use the token",
      path: "packages/ui/src/button.tsx",
      line: 12,
      createdAt: "2026-09-18T00:00:00Z",
      updatedAt: "2026-09-18T00:00:00Z",
      inReplyToId: null,
      commitId: head,
    };
    const { deps, err } = harness(fakeClient({ inline: () => [root] }));

    expect(await runCli(["--merge-check"], deps)).toBe(11);
    expect(err.join("\n")).toContain("MERGE refused: open-comments");
  });

  it("blesses a green PR", async () => {
    const client = fakeClient({ runs: () => [checkRun("unit", "completed", "success")] });
    const { deps, out } = harness(client);

    expect(await runCli(["--merge-check"], deps)).toBe(0);
    expect(out.join("\n")).toContain("MERGE ready");
  });
});

describe("command line", () => {
  it("treats an unknown option as an error", async () => {
    const { deps, err } = harness();
    expect(await runCli(["--nonsense"], deps)).toBe(1);
    expect(err.join("\n")).toContain('unknown option "--nonsense"');
  });

  it("prints usage on --help without touching GitHub", async () => {
    const { deps, out } = harness();
    expect(await runCli(["--help"], deps)).toBe(0);
    expect(out.join("\n")).toContain("pr-watch --watch");
  });
});

describe("gh client", () => {
  it("parses check runs and legacy statuses from paginated JSON lines", () => {
    const client = createGhClient((args) => {
      const joined = args.join(" ");

      if (joined.includes("nameWithOwner")) {
        return "0xZ0uk/PorkBot\n";
      }

      if (joined.includes("check-runs")) {
        return (
          '{"name":"unit","status":"completed","conclusion":"success","html_url":"https://example.test/job/1"}\n' +
          '{"name":"build","status":"in_progress","conclusion":null,"html_url":"https://example.test/job/2"}\n'
        );
      }

      if (joined.includes("/status")) {
        return '{"context":"legacy/check","state":"pending"}\n';
      }

      throw new Error(`unexpected gh call: ${joined}`);
    });

    expect(client.checkRuns("abc")).toEqual([
      {
        name: "unit",
        status: "completed",
        conclusion: "success",
        url: "https://example.test/job/1",
      },
      {
        name: "build",
        status: "in_progress",
        conclusion: null,
        url: "https://example.test/job/2",
      },
    ]);
    expect(client.commitStatuses("abc")).toEqual([{ context: "legacy/check", state: "pending" }]);
  });

  it("maps review comments and reviews onto their domain fields", () => {
    const client = createGhClient((args) => {
      const joined = args.join(" ");

      if (joined.includes("nameWithOwner")) {
        return "0xZ0uk/PorkBot\n";
      }

      if (joined.includes("/comments")) {
        return (
          '{"id":5,"user":{"login":"coderabbitai[bot]"},"body":"hi","path":"a.ts","line":3,' +
          '"created_at":"2026-09-18T00:00:00Z","updated_at":"2026-09-18T00:00:00Z",' +
          '"in_reply_to_id":null,"commit_id":"abc"}\n'
        );
      }

      if (joined.includes("/reviews")) {
        return (
          '{"id":1,"user":{"login":"reviewer"},"state":"CHANGES_REQUESTED","body":"split",' +
          '"submitted_at":"2026-09-18T00:00:00Z","commit_id":"abc"}\n'
        );
      }

      throw new Error(`unexpected gh call: ${joined}`);
    });

    expect(client.reviewComments(22)[0]).toMatchObject({
      id: 5,
      author: "coderabbitai[bot]",
      line: 3,
    });
    expect(client.reviews(22)[0]).toMatchObject({ id: 1, state: "CHANGES_REQUESTED" });
  });
});
