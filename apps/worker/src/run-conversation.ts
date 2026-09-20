import { createThreadSnapshot, messageText, reduceRunEvent } from "@porkbot/core";
import type { ModelMessage } from "@porkbot/adapter-kit";
import type { RunReader, ThreadTranscriptReader } from "@porkbot/db";
import type { RunEventReader } from "@porkbot/effect";

/**
 * The conversation a new run continues (slice 6.11).
 *
 * A thread's assistant turns live in its durable event stream, not in message
 * rows: the user's turns are rows (`threads.messages`) and every assistant turn
 * is a sequence of `token.delta`s under a message id, exactly the stream the
 * console reduces. This module rebuilds the two into one ordered conversation
 * from the same reducer the console uses, so a later run is prompted with what
 * the operator actually read rather than with a second parsing of the same
 * events.
 *
 * The order is per run, oldest first. A thread has at most one live run at a
 * time, so run order is conversation order; within a run, the message rows that
 * name it come first — the message that started it, then any steering rows —
 * and the event-derived turns follow in stream order, deduplicated by message
 * id, because a steering row and its `run.steered` event are the same turn.
 *
 * The new run's own user turn is returned as `prompt` and left out of
 * `history`: the agent loop appends it when the prompt starts, and handing it
 * in twice would send the model the same turn twice.
 */

/** How many rows one page of the replay reads. */
export const CONVERSATION_PAGE_LIMIT = 200;
/**
 * The most pages the replay walks. A thread larger than this is a conversation
 * that needs compaction, not a silent truncation: the run fails and says so
 * rather than answering with a hole in its history.
 */
export const CONVERSATION_MAX_PAGES = 50;

/** The reads the conversation is assembled from; all scoped to the job's space. */
export interface ConversationReader {
  readonly messages: ThreadTranscriptReader;
  readonly events: RunEventReader;
  readonly runs: Pick<RunReader, "listForThread">;
}

export interface BuiltConversation {
  /** The turns before this run's prompt, oldest first. */
  readonly history: readonly ModelMessage[];
  /** The operator's message this run answers. */
  readonly prompt: string;
}

/** A transcript the run cannot answer: no user turn to prompt the model with. */
export class ConversationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationUnavailableError";
  }
}

interface Turn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Rebuilds one thread's conversation for the run about to execute. It reads
 * every page it needs rather than a fixed window, and a thread that outgrows
 * the page budget fails with a sentence the operator can act on.
 */
export async function buildRunConversation(
  reader: ConversationReader,
  threadId: string,
  runId: string,
): Promise<BuiltConversation> {
  const runs = [...(await reader.runs.listForThread(threadId))].reverse();
  const rows = await readAllPages(
    (afterSeq) =>
      reader.messages.listForThread(threadId, {
        limit: CONVERSATION_PAGE_LIMIT,
        afterSeq,
      }),
    // Message positions are 0-based and the read is exclusive, so the first
    // page starts before zero; event positions are 1-based and start at zero.
    -1,
  );
  const events = await readAllPages(
    (afterSeq) => reader.events.listAfter(threadId, afterSeq, CONVERSATION_PAGE_LIMIT),
    0,
  );

  let snapshot = createThreadSnapshot(threadId);

  for (const event of events) {
    const reduced = reduceRunEvent(snapshot, event);

    if (!reduced.ok) {
      throw new ConversationUnavailableError(
        `this thread's event stream could not be replayed: ${reduced.error.message}`,
      );
    }

    snapshot = reduced.snapshot;
  }

  const rowsByRun = new Map<string, typeof rows>();
  const seen = new Set<string>();
  // A steering row is the durable half of a `run.steered` event. The event is
  // the turn's position in the run — it can arrive after an assistant turn —
  // so the row is not repeated as a leading turn; the reducer's snapshot
  // carries it where it happened.
  const steered = new Set<string>();

  for (const event of events) {
    if (event.type === "run.steered") {
      steered.add(event.messageId);
    }
  }

  for (const row of rows) {
    if (row.runId === null || steered.has(row.id)) {
      continue;
    }

    const current = rowsByRun.get(row.runId);

    if (current === undefined) {
      rowsByRun.set(row.runId, [row]);
    } else {
      current.push(row);
    }
  }

  const turnsByRun = new Map<string, Turn[]>();

  for (const run of runs) {
    const turns: Turn[] = [];

    for (const row of rowsByRun.get(run.id) ?? []) {
      if (row.role !== "user") {
        continue;
      }

      const text = messageText(row.blocks) ?? "";

      if (text.trim() !== "") {
        seen.add(row.id);
        turns.push({ id: row.id, role: "user", text });
      }
    }

    for (const message of snapshot.messages) {
      if (message.runId !== run.id || seen.has(message.id)) {
        continue;
      }

      if (message.text.trim() !== "") {
        turns.push({ id: message.id, role: message.role, text: message.text });
      }
    }

    turnsByRun.set(run.id, turns);
  }

  const current = turnsByRun.get(runId) ?? [];
  const promptIndex = current.findIndex((turn) => turn.role === "user");

  if (promptIndex === -1) {
    throw new ConversationUnavailableError(
      "this run has no operator message to answer; scheduled runs are not supported yet",
    );
  }

  const prompt = current[promptIndex]?.text ?? "";
  const history: ModelMessage[] = [];

  for (const run of runs) {
    for (const turn of turnsByRun.get(run.id) ?? []) {
      if (run.id === runId && turn.id === current[promptIndex]?.id) {
        continue;
      }

      history.push({ role: turn.role, content: turn.text });
    }
  }

  return { history, prompt };
}

async function readAllPages<Row extends { readonly seq: number }>(
  read: (afterSeq: number) => Promise<readonly Row[]>,
  firstAfterSeq: number,
): Promise<Row[]> {
  const rows: Row[] = [];
  let afterSeq = firstAfterSeq;

  for (let page = 0; page < CONVERSATION_MAX_PAGES; page += 1) {
    const batch = await read(afterSeq);

    rows.push(...batch);

    if (batch.length < CONVERSATION_PAGE_LIMIT) {
      return rows;
    }

    const last = batch.at(-1);

    if (last === undefined || last.seq <= afterSeq) {
      throw new ConversationUnavailableError("this thread's transcript did not advance a page");
    }

    afterSeq = last.seq;
  }

  throw new ConversationUnavailableError(
    "this thread's transcript is too large to replay; compact it before the next run",
  );
}
