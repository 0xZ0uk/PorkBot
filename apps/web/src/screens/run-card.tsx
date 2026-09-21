import type { RunSnapshot } from "@porkbot/core";
import { Card, Icon } from "@porkbot/ui";
import { formatDuration } from "../run-outcome.ts";
import type { RunOutcomeLine } from "../run-outcome.ts";

/**
 * A terminal run's report card (slice 13.8; design record, Conversation
 * grammar): the outcome as ✓ done lines and → follow-up lines, above the prose
 * the run wrote. The lines are derived by `runOutcome` from the same reduced
 * events the timeline renders, so the card never disagrees with the audit
 * trail beneath it and a reload renders the card the stream showed.
 *
 * The head says which way the run ended — finished, failed or stopped — and
 * the note carries the run's scale (steps and total tool time) because the
 * snapshot holds no wall-clock timestamps; a run that failed before its first
 * call still closes with its one line.
 */

export interface RunCardEntryProps {
  readonly run: RunSnapshot;
  readonly outcome: readonly RunOutcomeLine[];
}

export function RunCardEntry({ run, outcome }: RunCardEntryProps) {
  const failed = run.status === "failed";
  const title = failed ? "Run failed" : run.status === "cancelled" ? "Run stopped" : "Run finished";
  const note = runNote(run);

  return (
    <li className="run-card">
      <Card variant="raised" className="run-card-body">
        <div className="run-card-head">
          <span
            className={failed ? "run-card-icon run-card-icon-failed" : "run-card-icon"}
            aria-hidden="true"
          >
            <Icon name={failed ? "alert" : "check"} size={15} />
          </span>
          <p className="run-card-title">{title}</p>
          {note === null ? null : <span className="run-card-note muted">{note}</span>}
        </div>
        <ul className="run-card-lines">
          {outcome.map((line, index) => (
            <li className="run-card-line" key={`${line.kind}:${String(index)}`}>
              <span
                className={
                  line.kind === "done"
                    ? "run-card-mark run-card-mark-done"
                    : "run-card-mark run-card-mark-follow-up"
                }
                aria-hidden="true"
              >
                {line.kind === "done" ? "✓" : "→"}
              </span>
              <span className="run-card-text">{line.text}</span>
            </li>
          ))}
        </ul>
      </Card>
    </li>
  );
}

/** The run's scale: how many calls it made and how long they took together. */
function runNote(run: RunSnapshot): string | null {
  const steps = run.toolCalls.length;
  const totalMs = run.toolCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
  const parts: string[] = [];

  if (steps > 0) {
    parts.push(steps === 1 ? "1 step" : `${String(steps)} steps`);
  }

  if (totalMs > 0) {
    parts.push(formatDuration(totalMs));
  }

  return parts.length === 0 ? null : parts.join(" · ");
}
