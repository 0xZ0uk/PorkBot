import { BotAvatar, Button } from "@porkbot/ui";
import { fileDownloadPath } from "@porkbot/contracts";
import type { Bot, RunLiveness } from "@porkbot/contracts";
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
  readonly botId: string;
  readonly state: ThreadConsoleState;
  /** Optional until the shell supplies the selected bot to the console. */
  readonly bot?: Bot;
  readonly avatarUrl?: string | null;
  readonly onRetry: () => void;
  readonly onApprovalDecision?:
    | ((input: {
        readonly runId: string;
        readonly callId: string;
        readonly vote: "approve" | "deny";
        readonly reason?: string;
      }) => Promise<void>)
    | undefined;
}

export function ThreadConsoleScreen({
  botId,
  state,
  bot,
  avatarUrl = null,
  onRetry,
  onApprovalDecision,
}: ThreadConsoleScreenProps) {
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
      {bot === undefined ? null : (
        <header className="thread-header">
          <BotAvatar id={bot.id} name={bot.name} color={bot.color} imageUrl={avatarUrl} size={40} />
          <div>
            <h2>{bot.name}</h2>
            <p className="muted">{bot.title || "Bot"}</p>
          </div>
        </header>
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
                botId={botId}
                threadId={state.threadId}
                runId={entry.runId}
                call={entry.call}
                {...(onApprovalDecision === undefined ? {} : { onApprovalDecision })}
              />
            ) : (
              <li
                key={entry.id}
                className={entry.streaming ? "message message-streaming" : "message"}
              >
                <div className="message-attribution">
                  {entry.role === "user" || bot === undefined ? null : (
                    <BotAvatar
                      id={bot.id}
                      name={bot.name}
                      color={bot.color}
                      imageUrl={avatarUrl}
                      size={24}
                    />
                  )}
                  <span className="message-role muted">
                    {entry.role === "user" ? "You" : (bot?.name ?? "Bot")}
                  </span>
                </div>
                <p className="message-text">{entry.text}</p>
                {entry.attachments.length === 0 ? null : (
                  <ul className="message-attachments">
                    {entry.attachments.map((file) => (
                      <li key={file.attachmentId}>
                        <a
                          className="message-attachment"
                          href={fileDownloadPath(file.attachmentId)}
                        >
                          {file.filename}
                          <span className="muted"> · {formatBytes(file.sizeBytes)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
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

/** File sizes on attachment chips: bytes, then KiB, then MiB. */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }

  const kib = bytes / 1_024;

  return kib < 1_024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1_024).toFixed(1)} MiB`;
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
