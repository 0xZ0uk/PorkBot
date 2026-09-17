import { execFileSync } from "node:child_process";

/**
 * The GitHub half of pr-watch. Everything that talks to `gh` lives here behind
 * `GhRunner`, a function that takes argv and returns stdout, which is what lets
 * the commands be tested against a scripted client instead of a live PR.
 *
 * `gh api --paginate --jq '<expr>'` prints one compact JSON value per line, so
 * every list endpoint is parsed line by line rather than by slurping pages.
 */

export type GhRunner = (args: readonly string[]) => string;

export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
}

export interface CommitStatus {
  readonly context: string;
  readonly state: string;
}

export interface PullMeta {
  readonly number: number;
  readonly state: string;
  readonly headRefOid: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly mergeable: string;
  readonly reviewDecision: string | null;
  readonly isDraft: boolean;
}

export interface ReviewComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly path: string;
  readonly line: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly inReplyToId: number | null;
  readonly commitId: string | null;
}

export interface IssueComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
}

export interface Review {
  readonly id: number;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string | null;
  readonly commitId: string | null;
}

export interface JobStep {
  readonly name: string;
  readonly number: number;
  readonly conclusion: string | null;
}

export interface JobDetail {
  readonly id: number;
  readonly runId: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
  readonly steps: readonly JobStep[];
}

/**
 * Everything the commands need from GitHub. The concrete implementation is
 * `createGhClient`; tests supply a scripted object.
 */
export interface PrWatchClient {
  repo(): string;
  viewer(): string;
  resolvePull(reference: string | undefined): number;
  pullMeta(pr: number): PullMeta;
  checkRuns(sha: string): readonly CheckRun[];
  commitStatuses(sha: string): readonly CommitStatus[];
  reviewComments(pr: number): readonly ReviewComment[];
  conversationComments(pr: number): readonly IssueComment[];
  reviews(pr: number): readonly Review[];
  job(jobId: string): JobDetail;
  jobLog(jobId: string): string;
  rerunFailed(runId: number): void;
  replyToReviewComment(commentId: number, body: string): void;
}

type Record_ = Record<string, unknown>;

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`could not parse ${label} as JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function asRecord(value: unknown, label: string): Record_ {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }

  return value as Record_;
}

function records(raw: string, label: string): readonly Record_[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => asRecord(parseJson(line, label), label));
}

function str(record: Record_, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record: Record_, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

function nullableStr(record: Record_, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function bool(record: Record_, key: string): boolean {
  return record[key] === true;
}

function authorOf(record: Record_): string {
  const user = record["user"];

  if (user !== null && typeof user === "object" && !Array.isArray(user)) {
    const login = (user as Record_)["login"];
    return typeof login === "string" ? login : "unknown";
  }

  return "unknown";
}

export function createGhClient(run: GhRunner): PrWatchClient {
  let cachedRepo: string | undefined;
  let cachedViewer: string | undefined;

  const repo = (): string => {
    cachedRepo ??= run([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]).trim();
    return cachedRepo;
  };

  const viewer = (): string => {
    if (cachedViewer === undefined) {
      // Integration tokens often cannot GET /user, and a failed REST call still
      // writes its error body to stdout, so GraphQL goes first and the result is
      // validated before it is trusted.
      let login: string;

      try {
        login = run([
          "api",
          "graphql",
          "-f",
          "query=query { viewer { login } }",
          "--jq",
          ".data.viewer.login",
        ]).trim();
      } catch {
        login = "";
      }

      if (login === "" || login.startsWith("{")) {
        login = run(["api", "user", "--jq", ".login"]).trim();
      }

      if (login === "" || login.startsWith("{")) {
        throw new Error("could not resolve the authenticated GitHub user; run `gh auth status`.");
      }

      cachedViewer = login;
    }

    return cachedViewer;
  };

  const apiRecords = (path: string, expression: string): readonly Record_[] =>
    records(run(["api", "--paginate", path, "--jq", expression]), path);

  return {
    repo,
    viewer,

    resolvePull(reference: string | undefined): number {
      const args =
        reference === undefined || reference === ""
          ? ["pr", "view", "--json", "number", "--jq", ".number"]
          : ["pr", "view", reference, "--json", "number", "--jq", ".number"];
      const number = Number.parseInt(run(args).trim(), 10);

      if (!Number.isInteger(number) || number <= 0) {
        throw new Error(
          `could not resolve a pull request${reference ? ` from "${reference}"` : ""}`,
        );
      }

      return number;
    },

    pullMeta(pr: number): PullMeta {
      const raw = run([
        "pr",
        "view",
        String(pr),
        "--repo",
        repo(),
        "--json",
        "number,state,headRefOid,headRefName,baseRefName,mergeable,reviewDecision,isDraft",
      ]);
      const record = asRecord(parseJson(raw, `pull request ${pr}`), `pull request ${pr}`);

      return {
        number: num(record, "number"),
        state: str(record, "state"),
        headRefOid: str(record, "headRefOid"),
        headRefName: str(record, "headRefName"),
        baseRefName: str(record, "baseRefName"),
        mergeable: str(record, "mergeable"),
        reviewDecision: nullableStr(record, "reviewDecision"),
        isDraft: bool(record, "isDraft"),
      };
    },

    checkRuns(sha: string): readonly CheckRun[] {
      return apiRecords(
        `repos/${repo()}/commits/${sha}/check-runs?per_page=100`,
        ".check_runs[]",
      ).map((record) => ({
        name: str(record, "name"),
        status: str(record, "status"),
        conclusion: nullableStr(record, "conclusion"),
        url: str(record, "html_url"),
      }));
    },

    commitStatuses(sha: string): readonly CommitStatus[] {
      return apiRecords(`repos/${repo()}/commits/${sha}/status?per_page=100`, ".statuses[]").map(
        (record) => ({
          context: str(record, "context"),
          state: str(record, "state"),
        }),
      );
    },

    reviewComments(pr: number): readonly ReviewComment[] {
      return apiRecords(`repos/${repo()}/pulls/${pr}/comments?per_page=100`, ".[]").map(
        (record) => ({
          id: num(record, "id"),
          author: authorOf(record),
          body: str(record, "body"),
          path: str(record, "path"),
          line: typeof record["line"] === "number" ? (record["line"] as number) : null,
          createdAt: str(record, "created_at"),
          updatedAt: str(record, "updated_at"),
          inReplyToId:
            typeof record["in_reply_to_id"] === "number"
              ? (record["in_reply_to_id"] as number)
              : null,
          commitId: nullableStr(record, "commit_id"),
        }),
      );
    },

    conversationComments(pr: number): readonly IssueComment[] {
      return apiRecords(`repos/${repo()}/issues/${pr}/comments?per_page=100`, ".[]").map(
        (record) => ({
          id: num(record, "id"),
          author: authorOf(record),
          body: str(record, "body"),
          createdAt: str(record, "created_at"),
          updatedAt: str(record, "updated_at"),
          htmlUrl: str(record, "html_url"),
        }),
      );
    },

    reviews(pr: number): readonly Review[] {
      return apiRecords(`repos/${repo()}/pulls/${pr}/reviews?per_page=100`, ".[]").map(
        (record) => ({
          id: num(record, "id"),
          author: authorOf(record),
          state: str(record, "state"),
          body: str(record, "body"),
          submittedAt: nullableStr(record, "submitted_at"),
          commitId: nullableStr(record, "commit_id"),
        }),
      );
    },

    job(jobId: string): JobDetail {
      const label = `job ${jobId}`;
      const record = asRecord(
        parseJson(run(["api", `repos/${repo()}/actions/jobs/${jobId}`]), label),
        label,
      );
      const steps = Array.isArray(record["steps"]) ? record["steps"] : [];

      return {
        id: num(record, "id"),
        runId: num(record, "run_id"),
        name: str(record, "name"),
        conclusion: nullableStr(record, "conclusion"),
        htmlUrl: str(record, "html_url"),
        steps: steps.map((step) => {
          const entry = asRecord(step, "job step");
          return {
            name: str(entry, "name"),
            number: num(entry, "number"),
            conclusion: nullableStr(entry, "conclusion"),
          };
        }),
      };
    },

    jobLog(jobId: string): string {
      return run(["run", "view", "--job", jobId, "--log-failed"]);
    },

    rerunFailed(runId: number): void {
      run(["run", "rerun", String(runId), "--failed"]);
    },

    replyToReviewComment(commentId: number, body: string): void {
      const url = run([
        "api",
        `repos/${repo()}/pulls/comments/${commentId}`,
        "--jq",
        ".pull_request_url",
      ]).trim();
      const pr = url.split("/").pop();

      if (pr === undefined || pr === "" || !/^\d+$/.test(pr)) {
        throw new Error(`could not resolve the pull request for comment ${commentId}`);
      }

      run([
        "api",
        "--method",
        "POST",
        `repos/${repo()}/pulls/${pr}/comments/${commentId}/replies`,
        "-f",
        `body=${body}`,
        "--jq",
        ".id",
      ]);
    },
  };
}

/**
 * The real runner: `gh` resolved from PATH, argv passed as an array so a body
 * with spaces or quotes cannot be re-split by a shell.
 */
export function execGhRunner(): GhRunner {
  return (args) => {
    try {
      return execFileSync("gh", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      const detail = typeof stderr === "string" && stderr.trim() !== "" ? `: ${stderr.trim()}` : "";
      throw new Error(`gh ${args.join(" ")} failed${detail}`, { cause: error });
    }
  };
}
