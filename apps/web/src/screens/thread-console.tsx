import { Button } from "@porkbot/ui";
import type { ThreadConsoleState } from "../console.ts";
import { ToolCallEntry } from "./tool-call.tsx";

/**
 * The thread console: the transcript, the tokens as they arrive, the tool
 * calls each run made, and one status line that says when the stream is not
 * plainly live.
 *
 * The screen is a pure function of the console's state — the controller owns
 * every decision — so the render is the same while a run streams and after a
 * replay put the same text on the wire. Connection state is visible without
 * being noisy: a live stream shows no chrome, and only `connecting`,
 * `reconnecting` and `resumed` appear, announced politely to assistive
 * technology.
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

  return (
    <section className="console" aria-busy={state.status === "loading"}>
      {connection === null ? null : (
        <p className="console-status muted" role="status">
          {connection}
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
