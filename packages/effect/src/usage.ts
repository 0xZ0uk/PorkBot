import { Effect } from "effect";

/**
 * The usage seam (slice 8.8, PRD story 34): one model call's tokens, reported
 * by the adapter that talked to the model and recorded by the layer that owns
 * the rows.
 *
 * Usage is observed, never demanded. An adapter reports it when a completed
 * assistant turn carries a report, the database layer appends it, and nothing
 * in the product reads it for admission, retry or budget — PRD's out-of-scope
 * line is explicit that v1.0 records and displays token usage and does not
 * charge for it (#183). That is why the report happens from the run's pump
 * beside the event stream rather than from the settlement: a run that fails or
 * is cancelled must keep the usage its completed turns already spent.
 *
 * Unknown usage is a first-class value. `inputTokens` and `outputTokens` are
 * nullable and a null means "the provider did not report this" — a different
 * fact from a reported zero, and one the screen renders as "not reported"
 * rather than as a number nobody measured. A provider that reports only one
 * half leaves the other null rather than back-filling a zero.
 *
 * The interface is a plain promise seam like `RunEventSink` and the other row
 * seams `@porkbot/db` implements: the adapters wrap `record` in
 * `Effect.tryPromise` and decide what a failure means for the run, while the
 * store stays free of an Effect dependency.
 */

/**
 * One model call's usage, addressed to the run that made the call. `provider`
 * and `model` name what produced it, when the provider said so; a null is
 * "not named" and never an invented name. Token fields are null when the
 * provider did not report them.
 */
export interface RunUsage {
  readonly runId: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * The write half of the usage seam. `@porkbot/db` implements it over the
 * usage rows; the run runtime receives one and reports each completed
 * model turn.
 *
 * A run outside the recorder's scope is the shared typed `NotFoundError`, the
 * same scoped refusal every other write raises — the matrix's cross-space probe
 * for the usage rows exercises exactly this. Any other failure is left to the
 * caller's classification: recording is observability, and a caller that cannot
 * record must not fail the run it observes.
 */
export interface UsageRecorder {
  record(usage: RunUsage): Promise<void>;
}

/**
 * The one place the "usage never fails a run" policy lives. Both run adapters
 * report through this helper, so a recorder that is absent is a no-op and a
 * rejected write — a foreign run, a database hiccup — costs the run nothing.
 * The catch is deliberately `catchAll`, not `catchAllCause`: typed failures are
 * swallowed, while a defect stays a defect and an interruption stays an
 * interruption, because a broken recorder and a lost lease are not the same
 * thing (PRD decision 26). A caller that wants the refusal observes it by
 * calling `record` directly, which is what the storage seam's own tests do.
 */
export function reportUsage(
  recorder: UsageRecorder | undefined,
  usage: RunUsage,
): Effect.Effect<void> {
  if (recorder === undefined) {
    return Effect.void;
  }

  return Effect.tryPromise(() => recorder.record(usage)).pipe(Effect.catchAll(() => Effect.void));
}
