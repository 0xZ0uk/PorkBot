import type { CheckRun, CommitStatus, PrWatchClient } from "./github.ts";

/**
 * Waiting is tied to a commit, not to a clock: every iteration reads the PR's
 * current head SHA and asks GitHub for *that* SHA's check runs and commit
 * statuses. The wait ends when the current head is terminal — never after a
 * fixed sleep — and a head that moves mid-wait resets the observation instead
 * of being mixed with the previous one. The deadline is a safety stop, not the
 * mechanism: it exists so a hang reports pending rather than blocking forever.
 */

export interface HeadObservation {
  readonly head: string;
  readonly runs: readonly CheckRun[];
  readonly statuses: readonly CommitStatus[];
  readonly pending: number;
  /** True when the head has no checks yet, so absence is not yet proof of none. */
  readonly emptyTerminal: boolean;
  readonly timedOut: boolean;
}

export interface WatchOptions {
  readonly pollMs: number;
  readonly deadlineMs: number;
  /** Consecutive empty observations to allow before accepting that no check exists. */
  readonly emptyPolls: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onObservation?: (observation: HeadObservation) => void;
}

export function isPendingRun(run: CheckRun): boolean {
  return run.status !== "completed";
}

export function failingConclusion(conclusion: string | null): boolean {
  return (
    conclusion !== null &&
    conclusion !== "success" &&
    conclusion !== "neutral" &&
    conclusion !== "skipped"
  );
}

export function pendingNames(
  runs: readonly CheckRun[],
  statuses: readonly CommitStatus[],
): readonly string[] {
  return [
    ...runs.filter(isPendingRun).map((run) => run.name),
    ...statuses.filter((status) => status.state === "pending").map((status) => status.context),
  ];
}

export function pendingCount(runs: readonly CheckRun[], statuses: readonly CommitStatus[]): number {
  return pendingNames(runs, statuses).length;
}

export async function waitForTerminalHead(
  client: PrWatchClient,
  pr: number,
  options: WatchOptions,
): Promise<HeadObservation> {
  const started = options.now();
  let lastHead = "";
  let emptyPolls = 0;

  for (;;) {
    const head = client.pullMeta(pr).headRefOid;

    if (head !== lastHead) {
      lastHead = head;
      emptyPolls = 0;
    }

    const runs = client.checkRuns(head);
    const statuses = client.commitStatuses(head);
    const pending = pendingCount(runs, statuses);
    const emptyTerminal = pending === 0 && runs.length === 0 && statuses.length === 0;
    const observation: HeadObservation = {
      head,
      runs,
      statuses,
      pending,
      emptyTerminal,
      timedOut: false,
    };

    if (pending === 0 && (!emptyTerminal || emptyPolls >= options.emptyPolls)) {
      return observation;
    }

    if (emptyTerminal) {
      emptyPolls += 1;
    }

    options.onObservation?.(observation);

    const elapsed = options.now() - started;
    const remaining = options.deadlineMs - elapsed;

    if (remaining <= 0) {
      return { ...observation, timedOut: true };
    }

    await options.sleep(Math.min(options.pollMs, remaining));
  }
}
