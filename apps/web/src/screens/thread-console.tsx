import { fileDownloadPath } from "@porkbot/contracts";
import type { Approval, Bot, RunLiveness } from "@porkbot/contracts";
import type { FileMessageBlock } from "@porkbot/core";
import { Badge, BotAvatar, Button, Card, Icon, ScrollArea } from "@porkbot/ui";
import type { CSSProperties } from "react";
import type { ThreadConsoleState, TranscriptEntry, TranscriptMessageEntry } from "../console.ts";
import { formatDuration } from "../run-outcome.ts";
import { RunCardEntry } from "./run-card.tsx";
import { ToolCallEntry } from "./tool-call.tsx";
import { useTranscriptAnchor } from "../use-transcript-anchor.ts";

/**
 * The thread console: the transcript and the composer's sibling status
 * (slice 13.7; design record, Conversation grammar).
 *
 * The screen is a pure function of the console's state — the controller owns
 * every decision — so the render is the same while a run streams and after a
 * replay put the same text on the wire. The grammar is messaging-native: the
 * operator's turns are filled and end-aligned, the bot's turns sit on a
 * surface and start-aligned under its identity, and a timestamp separator
 * opens every session, so the speaker is legible before a word is read. The
 * attribution word stays in the DOM for a screen reader even where the
 * speaker is carried by alignment.
 *
 * Attachments are cards with the file's name, type and size and one open
 * action; a tool call keeps its own timeline entry in place in the
 * transcript. Connection state is a chip rather than a sentence — a live
 * stream shows no chrome, and only `connecting`, `reconnecting` and
 * `resumed` appear. The live strip names the step and the heartbeat lag, so
 * work and a hang read differently, and it goes stale when the liveness read
 * does (slice 6.10, story 22; slice 13.8). A settled run closes with its
 * report card above the prose it wrote (slice 13.8, story 39).
 *
 * The transcript scrolls itself rather than the pane: it opens on the newest
 * turn, follows a streaming run while the reader is at the bottom, and offers
 * a jump-to-latest control once they scroll away.
 */

export interface ThreadConsoleScreenProps {
  readonly botId: string;
  readonly state: ThreadConsoleState;
  /** The selected bot, for the assistant attribution and the identity colour. */
  readonly bot?: Bot;
  readonly avatarUrl?: string | null;
  readonly onRetry: () => void;
  readonly onApprovalDecision?:
    | ((input: {
        readonly runId: string;
        readonly callId: string;
        readonly vote: "approve" | "deny";
        readonly reason?: string;
      }) => Promise<Approval>)
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
  const anchor = useTranscriptAnchor(state.entries);

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
  const sessions = groupTranscriptSessions(state.entries);

  return (
    <section className="console" aria-busy={state.status === "loading"}>
      {connection === null ? null : (
        <div className="console-state-row">
          <span className="console-connection" role="status">
            <Badge tone="info">
              <Icon name="info" size={12} />
              {connection}
            </Badge>
          </span>
        </div>
      )}
      {liveness === null ? null : (
        <LiveStrip
          liveness={liveness}
          stale={state.livenessStale}
          {...(bot === undefined ? {} : { color: bot.color })}
        />
      )}
      <div className="conversation-transcript">
        <ScrollArea
          label="Transcript"
          className="transcript-scroll"
          ref={anchor.ref}
          onScroll={anchor.onScroll}
        >
          <div className="thread-column">
            {state.entries.length === 0 ? (
              state.status === "ready" ? (
                <p className="muted">No messages yet.</p>
              ) : null
            ) : (
              sessions.map((session) => (
                <div className="transcript-session" key={session.key}>
                  {session.label === null ? null : (
                    <p className="transcript-separator">
                      <time dateTime={session.startedAt ?? undefined}>{session.label}</time>
                    </p>
                  )}
                  <ol className="transcript">
                    {session.entries.map((entry) => {
                      if (entry.kind === "tool") {
                        return (
                          <ToolCallEntry
                            key={entry.id}
                            botId={botId}
                            threadId={state.threadId}
                            runId={entry.runId}
                            call={entry.call}
                            {...(bot === undefined ? {} : { bot })}
                            {...(onApprovalDecision === undefined ? {} : { onApprovalDecision })}
                          />
                        );
                      }

                      if (entry.kind === "run") {
                        return (
                          <RunCardEntry key={entry.id} run={entry.run} outcome={entry.outcome} />
                        );
                      }

                      return (
                        <MessageTurn
                          key={entry.id}
                          entry={entry}
                          {...(bot === undefined ? {} : { bot })}
                          avatarUrl={avatarUrl}
                        />
                      );
                    })}
                  </ol>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
        {anchor.atLatest || state.entries.length === 0 ? null : (
          <div className="transcript-jump">
            <Button variant="neutral" onClick={anchor.jumpToLatest}>
              <Icon name="chevron-down" size={14} />
              Jump to latest
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

interface MessageTurnProps {
  readonly entry: TranscriptMessageEntry;
  readonly bot?: Bot;
  readonly avatarUrl: string | null;
}

/**
 * One message in the transcript: a bubble with the speaker's attribution. The
 * operator's attribution is present for assistive technology but not painted —
 * alignment and fill carry the speaker — while the bot's names the bot beside
 * its mascot.
 */
function MessageTurn({ entry, bot, avatarUrl }: MessageTurnProps) {
  const operator = entry.role === "user";
  const classes = [
    "message",
    operator ? "message-user" : "message-bot",
    entry.streaming ? "message-streaming" : null,
  ]
    .filter((name): name is string => name !== null)
    .join(" ");

  return (
    <li className={classes}>
      <div className="message-body">
        <div className={operator ? "message-attribution sr-only" : "message-attribution"}>
          {operator ? (
            <span className="message-role">You</span>
          ) : (
            <>
              {bot === undefined ? null : (
                <BotAvatar
                  id={bot.id}
                  name={bot.name}
                  color={bot.color}
                  imageUrl={avatarUrl}
                  size={24}
                />
              )}
              <span className="message-role">{bot?.name ?? "Bot"}</span>
            </>
          )}
        </div>
        <Card variant="raised" className="message-bubble">
          <p className="message-text">{entry.text}</p>
          {entry.attachments.length === 0 ? null : (
            <ul className="message-attachments">
              {entry.attachments.map((file) => (
                <AttachmentCard key={file.attachmentId} file={file} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </li>
  );
}

/** One stored file: its name, type and size, with the card itself opening it. */
function AttachmentCard({ file }: { readonly file: FileMessageBlock }) {
  return (
    <Card as="li" className="attachment-card">
      <a className="message-attachment" href={fileDownloadPath(file.attachmentId)}>
        <span className="attachment-icon" aria-hidden="true">
          <Icon name="download" size={14} />
        </span>
        <span className="attachment-body">
          <span className="attachment-name">{file.filename}</span>
          <span className="attachment-meta muted">
            {file.contentType} · {formatBytes(file.sizeBytes)}
          </span>
        </span>
        <span className="attachment-action">Open</span>
      </a>
    </Card>
  );
}

/**
 * What the status chip says, or `null` for a live stream — the one state that
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
 * The live strip (slice 13.8, story 22): the step the run is on and the beat
 * that says whether it is still getting anywhere. The dot carries the state
 * the shell's vocabulary already names — the identity hue while working, the
 * accent while the run waits on the operator, the warning colour while stuck —
 * and the step names what is happening in the operator's words.
 *
 * Staleness is the one state the run does not have: when the liveness read
 * fails, the last assessment is still true as of its last read, so the strip
 * keeps the step and says the signal stopped instead of presenting a frozen
 * beat as current. `data-liveness` is the hook a test or a stylesheet reads.
 */
function LiveStrip({
  liveness,
  stale,
  color,
}: {
  readonly liveness: RunLiveness;
  readonly stale: boolean;
  readonly color?: string | null;
}) {
  const state = stale ? "stale" : liveness.state;
  const style =
    color === undefined || color === null
      ? undefined
      : ({ "--pb-live-color": color } as CSSProperties);

  return (
    <div
      className={["live-strip", `live-strip-${state}`].join(" ")}
      data-liveness={state}
      role="status"
      style={style}
    >
      <span className="live-strip-dot" aria-hidden="true" />
      <span className="live-strip-step">{stepLabel(liveness)}</span>
      <span className="live-strip-beat muted">
        {stale ? "signal lost" : `heartbeat ${formatDuration(liveness.heartbeatLagMs)} ago`}
      </span>
    </div>
  );
}

/**
 * What the run is doing, in the operator's words: the step the API assessed,
 * with the tool when one is named. A stuck run says how long progress has been
 * missing; everything else stays a word, because the beat beside it is the
 * liveness signal.
 */
function stepLabel(liveness: RunLiveness): string {
  switch (liveness.state) {
    case "starting":
      return "Starting…";
    case "thinking":
      return "Thinking…";
    case "working":
      return liveness.tool === null ? "Working…" : `Running ${liveness.tool}…`;
    case "waiting":
      return liveness.tool === null
        ? "Waiting for approval…"
        : `Waiting for approval: ${liveness.tool}…`;
    case "stopping":
      return "Stopping…";
    case "stuck":
      return `Stuck — no progress for ${formatDuration(liveness.sinceProgressMs)}`;
  }
}

/** The grouping window: turns this close together read as one burst. */
export const sessionGapMs = 5 * 60 * 1_000;

export interface TranscriptSession {
  readonly key: string;
  /** The separator's words, or `null` when the session has no persisted time. */
  readonly label: string | null;
  readonly startedAt: string | null;
  readonly entries: readonly TranscriptEntry[];
}

/**
 * The transcript's sessions: the first turn opens one, and a message more than
 * five minutes after the last persisted time opens the next (design record,
 * Conversation grammar — the Slack grouping window). A turn the stream knows
 * before the transcript does carries no time and inherits the session beside
 * it, so a live frame and a reload group the same way.
 */
export function groupTranscriptSessions(
  entries: readonly TranscriptEntry[],
  now: Date = new Date(),
): TranscriptSession[] {
  const sessions: { startedAt: string | null; entries: TranscriptEntry[] }[] = [];
  let lastAt: number | null = null;

  for (const entry of entries) {
    const createdAt = entry.kind === "message" ? entry.createdAt : null;
    const parsed = createdAt === null ? Number.NaN : Date.parse(createdAt);
    const at = Number.isNaN(parsed) ? null : parsed;
    const startsNew =
      sessions.length === 0 || (at !== null && lastAt !== null && at - lastAt > sessionGapMs);

    if (startsNew) {
      sessions.push({ startedAt: at === null ? null : createdAt, entries: [] });
    }

    sessions.at(-1)?.entries.push(entry);

    if (at !== null) {
      lastAt = at;
    }
  }

  return sessions.map((session, index) => ({
    key: `${session.startedAt ?? "live"}-${String(index)}`,
    startedAt: session.startedAt,
    label: session.startedAt === null ? null : sessionLabel(session.startedAt, now),
    entries: session.entries,
  }));
}

/** The day part of a separator that is not today, in the interface's copy. */
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/**
 * The time part: the reader's own clock, 24-hour and zero-padded, so the
 * separator reads the same on every machine rather than following a locale's
 * AM/PM or separator choice.
 */
function formatTime(iso: string): string {
  const at = new Date(iso);

  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** A session separator's words: the day when it is not today, then the time. */
export function sessionLabel(createdAt: string, now: Date): string {
  const at = new Date(createdAt);
  const time = formatTime(createdAt);

  if (sameDay(at, now)) {
    return `Today · ${time}`;
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  if (sameDay(at, yesterday)) {
    return `Yesterday · ${time}`;
  }

  return `${dayFormat.format(at)} · ${time}`;
}

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** File sizes on attachment cards: bytes, then KiB, then MiB. */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }

  const kib = bytes / 1_024;

  return kib < 1_024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1_024).toFixed(1)} MiB`;
}
