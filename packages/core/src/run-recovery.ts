/**
 * What a reclaimed run may do next.
 *
 * A reclaim is not a claim: the run was already executing under a worker that
 * stopped heartbeating, and the row's `checkpoint` is the only honest record of
 * how far it got. PRD decision 25 states the rule this module encodes — reclaim
 * means resume-from-checkpoint or fail, never a silent restart from scratch —
 * and `checkpoint` is NOT NULL jsonb defaulting to `{}` precisely so "there is
 * no state yet" is a value the rule can read (slice 2.3).
 *
 * The decision is pure and total so both reclaim paths (the watchdog job and
 * the run-execute handler) answer identically, and so the rule is tested
 * exhaustively without a database. The failure reasons are the run's durable
 * `error_code`: a closed vocabulary rather than free text, because a client and
 * an operator both need to branch on why a run could not continue.
 */

/** Why a reclaimed run cannot resume from its checkpoint. */
export const RUN_RECLAIM_FAILURES = ["checkpoint_absent", "checkpoint_unreadable"] as const;

export type RunReclaimFailure = (typeof RUN_RECLAIM_FAILURES)[number];

/**
 * The decision for one reclaimed run: resume when the checkpoint carries
 * session state, fail with a typed reason otherwise. The two failure reasons
 * stay distinct because they mean different things in a log: `absent` is a
 * worker that died before its first checkpoint, `unreadable` is a checkpoint a
 * writer stored in a shape this version does not understand.
 */
export type ReclaimDecision =
  { readonly resume: true } | { readonly resume: false; readonly reason: RunReclaimFailure };

/**
 * A checkpoint is resumable when it is a non-empty object. `{}` is the column's
 * honest default and means "no checkpoint yet"; an array or a scalar is not a
 * compacted session state at all. The check is own-property based, so an object
 * whose prototype happens to carry keys cannot pass as state.
 */
export function isResumableCheckpoint(checkpoint: unknown): checkpoint is Record<string, unknown> {
  if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint)) {
    return false;
  }

  return Object.keys(checkpoint).length > 0;
}

export function decideReclaim(checkpoint: unknown): ReclaimDecision {
  if (isResumableCheckpoint(checkpoint)) {
    return { resume: true };
  }

  if (typeof checkpoint === "object" && checkpoint !== null && !Array.isArray(checkpoint)) {
    // A well-typed object that carries no state: the worker stopped before its
    // first checkpoint, so there is nothing a resume could continue.
    return { resume: false, reason: "checkpoint_absent" };
  }

  return { resume: false, reason: "checkpoint_unreadable" };
}

/** The operator-safe sentence stored on a run that could not be resumed. */
export function reclaimFailureMessage(reason: RunReclaimFailure): string {
  switch (reason) {
    case "checkpoint_absent":
      return "The worker stopped before the run stored a checkpoint, so there was nothing to resume.";
    case "checkpoint_unreadable":
      return "The run's checkpoint is not a session state object, so there was nothing a resume could trust.";
  }
}
