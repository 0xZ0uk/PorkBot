import { ORPCError, subscribeThreadEvents } from "@porkbot/contracts";
import type {
  Message,
  RunGet,
  RunLiveness,
  ThreadEventsProcedure,
  ThreadSubscriptionState,
} from "@porkbot/contracts";
import {
  createThreadSnapshot,
  isActiveStatus,
  isTerminalStatus,
  messageFiles,
  messageText,
  reduceRunEvent,
} from "@porkbot/core";
import type {
  BackoffPolicy,
  FileMessageBlock,
  RunSnapshot,
  ThreadSnapshot,
  ToolCallSnapshot,
} from "@porkbot/core";

/**
 * The thread console: one thread's transcript, read live (story 18) and
 * resumable (story 19).
 *
 * The console is a framework-free state machine, like the session controller:
 * it owns the subscription, folds every frame through the reducer in
 * `@porkbot/core`, and publishes one state object a React binding renders.
 * Nothing here parses an event itself — the reducer is the only interpretation
 * of the stream — and nothing here re-implements the reconnect loop: the
 * contracts' `subscribeThreadEvents` owns the backoff and reports the
 * connection phase the screen shows.
 *
 * Resume is a replay, not a cursor the tab has to keep. A reload starts a
 * fresh snapshot at seq 0 and the durable rows are the stream, so the server
 * replays every event and the reducer rebuilds exactly the snapshot the wire
 * would have produced. The signed cursor still does its work inside one
 * connection — a dropped socket resumes from the last received id without a
 * duplicate or a gap — but a reload never depends on a client-held cursor that
 * a process restart could invalidate.
 *
 * The transcript fetch seeds what the event vocabulary does not carry: the
 * user message that started a run is a `message` row, not a run event, so the
 * merged view takes its order and its user turns from `threads.messages` and
 * its assistant text from the reducer — a partial message while tokens stream,
 * the same text once the run closes it.
 *
 * The tool-call timeline (slice 6.8) is the same reduced state read a second
 * way: every run's `toolCalls` are entries beside the messages, anchored to
 * the run they belong to — after the user message that prompted it when the
 * transcript carries one, before the run's first message when it does not (a
 * routine run has no user row). A live frame and a reload's replay therefore
 * produce the same timeline, because both assemble it from the same snapshot.
 *
 * The transcript is read once per start: a run-starting message written in
 * another tab while this console is mounted is not in the event vocabulary, so
 * it appears on the next mount rather than live. Steering messages do arrive
 * as events, and a run that produces one shows it immediately.
 *
 * Liveness (slice 6.10, story 22) is the one read that is not an event: lag and
 * progress age grow with the wall clock, so while a run is active the console
 * re-reads the API's assessment on an interval and stops the moment the run
 * settles. The assessment itself is computed server-side from the persisted
 * row with the same function the notification path uses, so a reload renders
 * the same numbers as the last live tick.
 */

/** The API surface the console needs, narrow enough to fake without a network. */
export interface ThreadConsoleTransport {
  /** The thread's persisted messages, oldest first. */
  transcript(threadId: string): Promise<readonly Message[]>;
  /** One run's persisted liveness, assessed by the API at request time. */
  run(runId: string): Promise<RunGet>;
  readonly events: ThreadEventsProcedure;
}

/** One rendered turn: a persisted message with its live text when there is one. */
export interface TranscriptMessageEntry {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /**
   * The stored files the message's blocks carry (slice 7.6). Only the
   * transcript row knows them — a steering message that arrived as a
   * `run.steered` event has text alone until the next mount — so a live frame
   * and a replay render the same chips.
   */
  readonly attachments: readonly FileMessageBlock[];
  /** True while the run is still appending tokens to this message. */
  readonly streaming: boolean;
}

/** One tool call of a run, rendered in place in the transcript. */
export interface TranscriptToolEntry {
  readonly kind: "tool";
  /** Unique across runs, because a call id is only unique within its run. */
  readonly id: string;
  readonly runId: string;
  readonly call: ToolCallSnapshot;
}

export type TranscriptEntry = TranscriptMessageEntry | TranscriptToolEntry;

export interface ThreadConsoleState {
  readonly threadId: string;
  readonly status: "loading" | "ready" | "refused";
  readonly entries: readonly TranscriptEntry[];
  /** The sentence to show when `status` is `refused`, else `null`. */
  readonly refusal: string | null;
  readonly connection: ThreadSubscriptionState;
  /** The newest active run's liveness, or `null` when none is running. */
  readonly liveness: RunLiveness | null;
}

export interface ThreadConsoleOptions {
  readonly transport: ThreadConsoleTransport;
  readonly threadId: string;
  /** How often the active run's liveness is re-read; defaults to five seconds. */
  readonly livenessIntervalMs?: number;
  /** Test seams, passed through to the contracts' reconnect loop. */
  readonly policy?: BackoffPolicy | undefined;
  readonly random?: (() => number) | undefined;
  readonly sleep?:
    ((delayMs: number, signal: AbortSignal | undefined) => Promise<void>) | undefined;
}

export interface ThreadConsole {
  state(): ThreadConsoleState;
  subscribe(listener: () => void): () => void;
  /** Starts loading and subscribing; a second call while running is a no-op. */
  start(): void;
  /** Ends the subscription; its in-flight work is ignored from here on. */
  stop(): void;
  /** Restarts from an empty snapshot: the reload path, offered after a refusal. */
  retry(): void;
  /**
   * Folds a message the operator's send just persisted into the view. The
   * event vocabulary does not carry the message that starts a run, so without
   * this the sender's own turn would appear only on the next mount; a steer is
   * folded the same way, and its `run.steered` frame is then a replay the
   * merge already dedupes. A message id already known — a nonce replay — is a
   * no-op.
   */
  noteSent(message: Message): void;
}

/**
 * The two sentences a refusal can produce. A missing thread is the API's typed
 * `NOT_FOUND`, whether the id is unknown or the actor's access is gone; every
 * other failure is something the client cannot name, so it says only that the
 * stream could not be read.
 */
const notAvailable = "This thread is not available.";
const streamUnreadable = "The stream could not be read.";

function refusalFor(error: unknown): string {
  return error instanceof ORPCError && error.code === "NOT_FOUND" ? notAvailable : streamUnreadable;
}

/**
 * The newest run the snapshot still considers active. A thread has at most one
 * live run (the send path steers rather than starting a second), but the
 * snapshot keeps history, so the search walks back to the newest one rather
 * than assuming the last entry is the live one.
 */
function newestActiveRun(snapshot: ThreadSnapshot): string | null {
  for (let index = snapshot.runs.length - 1; index >= 0; index -= 1) {
    const run = snapshot.runs[index];

    if (run !== undefined && isActiveStatus(run.status)) {
      return run.runId;
    }
  }

  return null;
}

export function createThreadConsole(options: ThreadConsoleOptions): ThreadConsole {
  const { transport, threadId } = options;
  const livenessIntervalMs = options.livenessIntervalMs ?? 5_000;
  const listeners = new Set<() => void>();
  let snapshot = createThreadSnapshot(threadId);
  let transcript: readonly Message[] = [];
  // Messages this console's own sends persisted: rows the transcript fetch may
  // have started before, so they merge beside it until a reload reads them
  // back as transcript.
  let sentMessages: readonly Message[] = [];
  let state: ThreadConsoleState = {
    threadId,
    status: "loading",
    entries: [],
    refusal: null,
    connection: "connecting",
    liveness: null,
  };
  // Bumped by stop/retry, so a slow fetch or frame from an earlier run never
  // writes into the state of a later one.
  let generation = 0;
  let running = false;
  let controller: AbortController | undefined;
  // The run the interval is following, and its last assessment. The run id is
  // the generation of the poll: a frame for a different active run moves it,
  // and a poll that returns after that is ignored.
  let livenessRunId: string | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | undefined;

  function setState(next: Partial<ThreadConsoleState>): void {
    state = { ...state, ...next };

    for (const listener of listeners) {
      listener();
    }
  }

  function stopLiveness(): void {
    if (livenessTimer !== undefined) {
      clearInterval(livenessTimer);
      livenessTimer = undefined;
    }

    livenessRunId = null;
  }

  /**
   * Follows the newest active run in the reduced snapshot. It is called after
   * every fold and after the transcript load, so the run whose events arrive is
   * the run that gets polled, and the terminal event ends the poll in the same
   * pass that ends the run.
   */
  function syncLiveness(): void {
    const active = newestActiveRun(snapshot);

    if (active === livenessRunId) {
      return;
    }

    stopLiveness();

    if (active === null) {
      if (state.liveness !== null) {
        setState({ liveness: null });
      }

      return;
    }

    livenessRunId = active;

    if (state.liveness !== null) {
      setState({ liveness: null });
    }

    const current = generation;
    void pollLiveness(active, current);
    livenessTimer = setInterval(() => {
      void pollLiveness(active, current);
    }, livenessIntervalMs);
  }

  async function pollLiveness(runId: string, current: number): Promise<void> {
    let read: RunGet;

    try {
      read = await transport.run(runId);
    } catch (error) {
      // The stream, not this read, is the console's source of truth: a failed
      // poll is retried on the next tick, and only a run that no longer exists
      // stops it — and clears the line rather than leaving a stale assessment
      // on screen. A contradiction still refuses in the frame loop above.
      if (current === generation && error instanceof ORPCError && error.code === "NOT_FOUND") {
        stopLiveness();

        if (state.liveness !== null) {
          setState({ liveness: null });
        }
      }

      return;
    }

    if (current !== generation || runId !== livenessRunId) {
      return;
    }

    if (read.liveness === null && isTerminalStatus(read.status)) {
      stopLiveness();
    }

    setState({ liveness: read.liveness });
  }

  async function run(current: number, active: AbortController): Promise<void> {
    let fetched: readonly Message[];

    try {
      fetched = await transport.transcript(threadId);
    } catch (error) {
      if (current === generation) {
        stopLiveness();
        setState({ status: "refused", refusal: refusalFor(error), liveness: null });
      }

      return;
    }

    // The generation is checked before the result is stored, not only before
    // the state is published: a fetch overtaken by a retry must not overwrite
    // the transcript the retry's own fetch already installed.
    if (current !== generation) {
      return;
    }

    transcript = fetched;
    setState({ status: "ready", entries: mergeTranscript(allMessages(), snapshot) });
    syncLiveness();

    try {
      const subscription = subscribeThreadEvents(
        transport.events,
        { threadId },
        {
          signal: active.signal,
          onState: (connection) => {
            if (current === generation) {
              setState({ connection });
            }
          },
          ...(options.policy === undefined ? {} : { policy: options.policy }),
          ...(options.random === undefined ? {} : { random: options.random }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        },
      );

      for await (const event of subscription) {
        if (current !== generation) {
          return;
        }

        const reduced = reduceRunEvent(snapshot, event);

        if (!reduced.ok) {
          // A contradiction in the stream is not something to repair here: the
          // reducer refuses to guess and the console says so.
          stopLiveness();
          setState({ status: "refused", refusal: streamUnreadable, liveness: null });

          return;
        }

        snapshot = reduced.snapshot;
        setState({ entries: mergeTranscript(allMessages(), snapshot) });
        syncLiveness();
      }
    } catch (error) {
      if (current === generation) {
        stopLiveness();
        setState({ status: "refused", refusal: refusalFor(error), liveness: null });
      }
    }
  }

  /**
   * Starts a run from an empty view. Both `start` and `retry` come through
   * here, so an instance that was stopped and started again cannot carry the
   * earlier run's snapshot or transcript into the new subscription.
   */
  function begin(): void {
    running = true;
    generation += 1;
    controller = new AbortController();
    snapshot = createThreadSnapshot(threadId);
    transcript = [];
    sentMessages = [];
    stopLiveness();

    setState({
      status: "loading",
      refusal: null,
      connection: "connecting",
      entries: [],
      liveness: null,
    });
    void run(generation, controller);
  }

  /**
   * The message list the merge renders: the fetched transcript plus the sends
   * this console persisted after it. A send the fetch already saw — a replay
   * of a row it read — is dropped here rather than rendered twice.
   */
  function allMessages(): readonly Message[] {
    const known = new Set(transcript.map((message) => message.id));
    return [...transcript, ...sentMessages.filter((message) => !known.has(message.id))];
  }

  return {
    state: () => state,

    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    start: () => {
      if (running) {
        return;
      }

      begin();
    },

    stop: () => {
      running = false;
      generation += 1;
      controller?.abort();
      controller = undefined;
      stopLiveness();
    },

    retry: () => {
      running = false;
      generation += 1;
      controller?.abort();
      begin();
    },

    noteSent: (message) => {
      if (
        sentMessages.some((sent) => sent.id === message.id) ||
        transcript.some((persisted) => persisted.id === message.id)
      ) {
        return;
      }

      sentMessages = [...sentMessages, message];
      setState({ entries: mergeTranscript(allMessages(), snapshot) });
    },
  };
}

/**
 * The rendered turns: persisted messages in their sequence order, each showing
 * the reducer's text for its id when the stream has one — a partial assistant
 * message while tokens arrive, the closed text after `run.completed` — plus
 * any message only the stream knows about, in stream order. Ordering stays the
 * transcript's because the transcript carries the per-thread sequence the
 * events do not repeat.
 *
 * A run's tool calls are then anchored to it: after the first user message
 * that names the run — the prompt a message-triggered run answers — or before
 * the run's first message when the transcript has no user row for it, which is
 * how a routine-triggered run reads. A run with no message at all appends in
 * run order, so a tool call that arrives before any text is still visible.
 * The anchor is computed fresh on every fold, so a frame that fills in a
 * missing message moves nothing that was already read.
 */
export function mergeTranscript(
  messages: readonly Message[],
  snapshot: ThreadSnapshot,
): TranscriptEntry[] {
  const reduced = new Map(snapshot.messages.map((message) => [message.id, message]));
  const rendered: TranscriptMessageEntry[] = [];
  const owners: (string | null)[] = [];
  const seen = new Set<string>();

  function pushMessage(entry: TranscriptMessageEntry, runId: string | null): void {
    rendered.push(entry);
    owners.push(runId);
  }

  for (const message of messages) {
    seen.add(message.id);
    const live = reduced.get(message.id);

    pushMessage(
      {
        kind: "message",
        id: message.id,
        role: message.role,
        text: live === undefined ? (messageText(message.blocks) ?? "") : live.text,
        attachments: messageFiles(message.blocks) ?? [],
        streaming: live !== undefined && !live.complete,
      },
      message.runId,
    );
  }

  for (const message of snapshot.messages) {
    if (seen.has(message.id)) {
      continue;
    }

    pushMessage(
      {
        kind: "message",
        id: message.id,
        role: message.role,
        text: message.text,
        attachments: [],
        streaming: !message.complete,
      },
      message.runId,
    );
  }

  const promptAt = new Map<string, number>();
  const firstAt = new Map<string, number>();

  owners.forEach((runId, index) => {
    if (runId === null) {
      return;
    }

    if (!firstAt.has(runId)) {
      firstAt.set(runId, index);
    }

    if (rendered[index]?.role === "user" && !promptAt.has(runId)) {
      promptAt.set(runId, index);
    }
  });

  const before = new Map<number, RunSnapshot[]>();
  const after = new Map<number, RunSnapshot[]>();
  const trailing: RunSnapshot[] = [];

  for (const run of snapshot.runs) {
    if (run.toolCalls.length === 0) {
      continue;
    }

    const prompt = promptAt.get(run.runId);

    if (prompt !== undefined) {
      after.set(prompt, [...(after.get(prompt) ?? []), run]);
      continue;
    }

    const first = firstAt.get(run.runId);

    if (first !== undefined) {
      before.set(first, [...(before.get(first) ?? []), run]);
      continue;
    }

    trailing.push(run);
  }

  const entries: TranscriptEntry[] = [];
  const pushTools = (run: RunSnapshot): void => {
    for (const call of run.toolCalls) {
      entries.push({
        kind: "tool",
        id: `tool:${run.runId}:${call.callId}`,
        runId: run.runId,
        call,
      });
    }
  };

  rendered.forEach((entry, index) => {
    for (const run of before.get(index) ?? []) {
      pushTools(run);
    }

    entries.push(entry);

    for (const run of after.get(index) ?? []) {
      pushTools(run);
    }
  });

  for (const run of trailing) {
    pushTools(run);
  }

  return entries;
}
