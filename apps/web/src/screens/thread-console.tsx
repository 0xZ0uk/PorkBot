import { Button } from "@porkbot/ui";
import type { RunLiveness } from "@porkbot/contracts";
import type { ThreadConsoleState } from "../console.ts";
import { ToolCallEntry } from "./tool-call.tsx";

/**
 * The thread console: the transcript, the tokens as they arrive, the tool
 * calls each run made, one status line for the connection when it is not
 * plainly live, and one for the running run's liveness (slice 6.10, story 22).
 *
 * The screen is a pure function of the console's state — the controller owns
 * every decision — so the render is the same while a run streams and after a
 * replay put the same text on the wire. Connection state is visible without
 * being noisy: a live stream shows no chrome, and only `connecting`,
 * `reconnecting` and `resumed` appear, announced politely to assistive
 * technology. The liveness line appears only while a run is active and names
 * the step and the heartbeat lag, so work and a hang read differently; a stuck
 * run is marked as such rather than rendered as healthy.
 */

export interface ThreadConsoleScreenProps {
  readonly state: ThreadConsoleState;
  readonly onRetry: () => void;
}

export function ThreadConsoleScreen({ state, onRetry }: ThreadConsoleScreenProps) {
  if (state.status === "refused") {
    return (
      <section className="console">
        <p className="form-error" role="alert">
          {state.refusal}
        </p>
        <Button onClick={onRetry}>Try again</Button>
      </section>
    );
  }

  const connection = connectionLabel(state.connection);
  const liveness = state.liveness;

  return (
    <section className="console" aria-busy={state.status === "loading"}>
      {connection === null ? null : (
        <p className="console-status muted" role="status">
          {connection}
        </p>
      )}
      {liveness === null ? null : (
        <p
          className={
            liveness.state === "stuck"
              ? "console-status console-liveness-stuck"
              : "console-status muted"
          }
          role="status"
          data-liveness={liveness.state}
        >
          {livenessLabel(liveness)}
        </p>
      )}
      {state.entries.length === 0 ? (
        state.status === "ready" ? (
          <p className="muted">No messages yet.</p>
        ) : null
      ) : (
        <ol className="transcript">
          {state.entries.map((entry) =>
            entry.kind === "tool" ? (
              <ToolCallEntry
                key={entry.id}
                threadId={state.threadId}
                runId={entry.runId}
                call={entry.call}
              />
            ) : (
              <li
                key={entry.id}
                className={entry.streaming ? "message message-streaming" : "message"}
              >
                <span className="message-role muted">{entry.role === "user" ? "You" : "Bot"}</span>
                <p className="message-text">{entry.text}</p>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}

/**
 * What the status line says, or `null` for a live stream — the one state that
 * needs no chrome. `resumed` is the stream that came back, so "Reconnecting…"
 * resolving into "Resumed" is the whole story a person needs.
 */
function connectionLabel(connection: ThreadConsoleState["connection"]): string | null {
  switch (connection) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "resumed":
      return "Resumed";
    case "live":
      return null;
  }
}

/**
 * The one line that says what the run is doing and whether it is still getting
 * anywhere: the step, and the heartbeat lag that tells a live worker from a
 * silent one. A stuck run says how long progress has been missing; everything
 * else carries the lag so the operator can see the beat without reading a log.
 */
function livenessLabel(liveness: RunLiveness): string {
  const beat = `heartbeat ${formatDuration(liveness.heartbeatLagMs)} ago`;

  switch (liveness.state) {
    case "starting":
      return `Starting… · ${beat}`;
    case "thinking":
      return `Thinking… · ${beat}`;
    case "working":
      return liveness.tool === null ? `Working… · ${beat}` : `Running ${liveness.tool}… · ${beat}`;
    case "waiting":
      return liveness.tool === null
        ? `Waiting for approval… · ${beat}`
        : `Waiting for approval: ${liveness.tool}… · ${beat}`;
    case "stopping":
      return `Stopping… · ${beat}`;
    case "stuck":
      return `Stuck — no progress for ${formatDuration(liveness.sinceProgressMs)} · ${beat}`;
  }
}

/** Durations in seconds under a minute, minutes under ten, then whole minutes. */
function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  return minutes >= 10 || rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
