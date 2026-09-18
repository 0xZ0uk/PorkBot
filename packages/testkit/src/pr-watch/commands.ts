import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildDigest } from "./digest.ts";
import type { GitState } from "./digest.ts";
import { classifyFailure, logExcerpt } from "./failure.ts";
import type { PrWatchClient } from "./github.ts";
import { failingConclusion, pendingNames, waitForTerminalHead } from "./watch.ts";

/**
 * The command surface of pr-watch. `runCli` takes its GitHub client, its IO and
 * its clock as arguments, so every verdict, refusal and exit code below is
 * exercised by tests without a live pull request; `cli.ts` is the thin wiring
 * that supplies the real ones.
 */

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export interface RunDeps {
  readonly client: PrWatchClient;
  readonly io: Io;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly git: GitState;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const refusedRerunExitCode = 3;

const usage = [
  "pr-watch — observe a pull request until its head commit settles, then act.",
  "",
  "Usage:",
  "  pr-watch [PR]                 one-shot digest of the PR (current branch if omitted)",
  "  pr-watch --watch [PR]         block until every check on the current head SHA is terminal",
  "  pr-watch --logs JOB_ID        the failing CI log, stripped to the lines that matter",
  "  pr-watch --classify JOB_ID    say whether a failed job looks like a test assertion or infrastructure",
  "  pr-watch --rerun JOB_ID [--evidence FILE]",
  "                                rerun a failed job only with proof the failure is unrelated",
  "  pr-watch --reply ID BODY      reply to an inline review comment thread",
  "  pr-watch --merge-check [PR]   refuse everything but a green, terminal, reviewed PR",
  "",
  "Environment:",
  "  PR_WATCH_POLL_MS      poll interval while watching (default 20000)",
  "  PR_WATCH_DEADLINE_MS  safety stop while watching (default 3600000)",
  "  PR_WATCH_EMPTY_POLLS  empty observations before accepting there are no checks (default 3)",
  "",
  "Exit codes: 0 green · 1 error · 3 refused rerun · 10 failures · 11 open comments",
  "            12 pending · 13 draft · 20 out of sync",
].join("\n");

interface ParsedArguments {
  readonly command:
    "digest" | "watch" | "logs" | "classify" | "rerun" | "reply" | "merge-check" | "help";
  readonly pr: string | undefined;
  readonly target: string | undefined;
  readonly body: string | undefined;
  readonly evidence: string | undefined;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let command: ParsedArguments["command"] = "digest";
  let watch = false;
  let pr: string | undefined;
  let target: string | undefined;
  let body: string | undefined;
  let evidence: string | undefined;

  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];

    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }

    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    switch (argument) {
      case "--watch":
        watch = true;
        break;
      case "--logs":
        command = "logs";
        target = take(index, argument);
        index += 1;
        break;
      case "--classify":
        command = "classify";
        target = take(index, argument);
        index += 1;
        break;
      case "--rerun":
        command = "rerun";
        target = take(index, argument);
        index += 1;
        break;
      case "--evidence":
        evidence = take(index, argument);
        index += 1;
        break;
      case "--reply":
        command = "reply";
        target = take(index, argument);
        body = take(index + 1, argument);
        index += 2;
        break;
      case "--merge-check":
        command = "merge-check";
        break;
      case "--help":
      case "-h":
        command = "help";
        break;
      default:
        if (argument.startsWith("-")) {
          throw new Error(`unknown option "${argument}"`);
        }

        pr = argument;
    }
  }

  if (watch) {
    if (command !== "digest") {
      throw new Error("--watch cannot be combined with another command");
    }

    command = "watch";
  }

  return { command, pr, target, body, evidence };
}

function numberFrom(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }

  return value;
}

function digestCommand(deps: RunDeps, pr: number, mergeCheck: boolean): number {
  const digest = buildDigest(deps.client, pr, {
    viewer: deps.client.viewer(),
    git: deps.git,
  });

  for (const line of digest.lines) {
    deps.io.out(line);
  }

  if (!mergeCheck) {
    return digest.exitCode;
  }

  if (digest.verdict === "green") {
    deps.io.out(
      "MERGE ready: every check is terminal and green, and no review finding is unresolved.",
    );
    return 0;
  }

  deps.io.err(
    `MERGE refused: ${digest.verdict}. Never merge with a pending review or an unresolved finding.`,
  );

  return digest.exitCode === 0 ? 1 : digest.exitCode;
}

async function watchCommand(deps: RunDeps, pr: number): Promise<number> {
  const pollMs = numberFrom(deps.env, "PR_WATCH_POLL_MS", 20_000);
  const deadlineMs = numberFrom(deps.env, "PR_WATCH_DEADLINE_MS", 3_600_000);
  const emptyPolls = numberFrom(deps.env, "PR_WATCH_EMPTY_POLLS", 3);
  let lastLine = "";

  const observation = await waitForTerminalHead(deps.client, pr, {
    pollMs,
    deadlineMs,
    emptyPolls,
    now: deps.now,
    sleep: deps.sleep,
    onObservation: (observed) => {
      const sha = observed.head.slice(0, 8);
      const line = observed.emptyTerminal
        ? `waiting ${sha} · no checks registered yet`
        : `waiting ${sha} · ${observed.pending} pending (${pendingNames(
            observed.runs,
            observed.statuses,
          )
            .slice(0, 8)
            .join(", ")})`;

      if (line !== lastLine) {
        deps.io.out(line);
        lastLine = line;
      }
    },
  });

  if (observation.timedOut) {
    deps.io.out(
      `timed out after ${Math.round(deadlineMs / 1000)}s with ${observation.pending} pending`,
    );
  }

  const exitCode = digestCommand(deps, pr, false);

  // A timeout on a PR whose checks never registered must not read as green.
  if (observation.timedOut && exitCode === 0) {
    deps.io.out("VERDICT pending (timed out before any check registered)");
    return 12;
  }

  return exitCode;
}

function logsCommand(deps: RunDeps, jobId: string): number {
  if (jobId === "") {
    throw new Error("--logs needs a job id");
  }

  const job = deps.client.job(jobId);
  const excerpt = logExcerpt(deps.client.jobLog(jobId));

  deps.io.out(`job ${job.id} "${job.name}" [${job.conclusion ?? "unknown"}] ${job.htmlUrl}`);
  deps.io.out(excerpt === "" ? "(no failed log lines found)" : excerpt);

  return 0;
}

function classifyCommand(deps: RunDeps, jobId: string): number {
  if (jobId === "") {
    throw new Error("--classify needs a job id");
  }

  const job = deps.client.job(jobId);
  const classification = classifyFailure(deps.client.jobLog(jobId));

  deps.io.out(
    `CLASS ${classification.kind} · job ${job.id} "${job.name}" [${job.conclusion ?? "unknown"}]`,
  );

  for (const line of classification.evidence) {
    deps.io.out(`  evidence: ${line.trim().slice(0, 200)}`);
  }

  return 0;
}

function rerunCommand(deps: RunDeps, jobId: string, evidencePath: string | undefined): number {
  if (jobId === "") {
    throw new Error("--rerun needs a job id");
  }

  const job = deps.client.job(jobId);

  if (!failingConclusion(job.conclusion)) {
    throw new Error(
      `job ${job.id} is not failing (conclusion ${job.conclusion ?? "unknown"}); nothing to rerun`,
    );
  }

  const classification = classifyFailure(deps.client.jobLog(jobId));
  let basis: string;

  if (classification.kind === "infrastructure") {
    basis = "infrastructure failure (setup or runner, not a test assertion)";
  } else if (evidencePath !== undefined && evidencePath !== "") {
    const content = readFileSync(evidencePath, "utf8");

    if (content.trim() === "") {
      throw new Error(
        `evidence file ${evidencePath} is empty; it must record the base-revision reproduction`,
      );
    }

    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    basis = `evidence ${evidencePath} (sha256:${hash})`;
  } else {
    deps.io.err(
      `refusing to rerun job ${job.id} "${job.name}": the failure looks like ` +
        `${classification.kind === "assertion" ? "a test assertion" : "an unclassified failure"}, ` +
        "not infrastructure.",
    );

    for (const line of classification.evidence) {
      deps.io.err(`  evidence: ${line.trim().slice(0, 200)}`);
    }

    deps.io.err(
      "Prove it unrelated first: reproduce the same failure on the base revision and rerun with " +
        "--evidence <file>, or show the job failed in setup before any test ran.",
    );

    return refusedRerunExitCode;
  }

  deps.io.out(`RERUN job ${job.id} "${job.name}" run=${job.runId} basis=${basis}`);
  deps.client.rerunFailed(job.runId);
  deps.io.out(`rerun requested for run ${job.runId} (failed jobs only)`);

  return 0;
}

function replyCommand(deps: RunDeps, commentId: string, body: string): number {
  const id = Number.parseInt(commentId, 10);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("--reply needs a numeric comment id");
  }

  if (body.trim() === "") {
    throw new Error("--reply needs a non-empty body");
  }

  deps.client.replyToReviewComment(id, body);

  deps.io.out(`replied to review comment ${id}`);

  return 0;
}

export async function runCli(argv: readonly string[], deps: RunDeps): Promise<number> {
  try {
    const parsed = parseArguments(argv);

    if (parsed.command === "help") {
      deps.io.out(usage);
      return 0;
    }

    switch (parsed.command) {
      case "digest":
        return digestCommand(deps, deps.client.resolvePull(parsed.pr), false);
      case "merge-check":
        return digestCommand(deps, deps.client.resolvePull(parsed.pr), true);
      case "watch":
        return await watchCommand(deps, deps.client.resolvePull(parsed.pr));
      case "logs":
        return logsCommand(deps, parsed.target ?? "");
      case "classify":
        return classifyCommand(deps, parsed.target ?? "");
      case "rerun":
        return rerunCommand(deps, parsed.target ?? "", parsed.evidence);
      case "reply":
        return replyCommand(deps, parsed.target ?? "", parsed.body ?? "");
    }
  } catch (error) {
    deps.io.err(`pr-watch: ${(error as Error).message}`);

    return 1;
  }
}
