import { ORPCError } from "@porkbot/contracts";
import type { Message } from "@porkbot/contracts";
import { RUN_EVENT_SCHEMA_VERSION, createThreadSnapshot, reduceRunEvents } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import {
  createScriptedEvents,
  runCompleted,
  runStarted,
  scriptedThreadTransport,
  textMessage,
  tokenDelta,
  toolCompleted,
  toolFailed,
  toolRequested,
} from "../test/fakes.ts";
import { createThreadConsole, mergeTranscript } from "./console.ts";
import type { ThreadConsoleState, TranscriptMessageEntry } from "./console.ts";

/**
 * The thread console's state machine, driven frame by frame: tokens appear
 * before a run completes, a reload replays to the same snapshot the wire would
 * have produced, a dropped connection resumes without duplicating a token, and
 * a typed refusal is a state with a retry rather than a dead screen.
 *
 * The fake subscription scripts drops exactly; the reconnect backoff is pinned
 * and its sleep injected, so no test waits on a real timer.
 */

const threadId = "thread-1";
const runId = "run-1";
const messageId = "message-1";

const pinnedPolicy = { baseDelayMs: 1, maxDelayMs: 10, multiplier: 2, jitterRatio: 0 };

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function consoleFor(
  transport: Parameters<typeof createThreadConsole>[0]["transport"],
  onState?: (state: ThreadConsoleState) => void,
) {
  const console = createThreadConsole({
    transport,
    threadId,
    policy: pinnedPolicy,
    sleep: async () => undefined,
  });

  if (onState !== undefined) {
    console.subscribe(() => onState(console.state()));
  }

  return console;
}

/** The message entries, for assertions about a view that may contain tool calls. */
function messagesOf(state: ThreadConsoleState): TranscriptMessageEntry[] {
  return state.entries.filter((entry): entry is TranscriptMessageEntry => entry.kind === "message");
}

function lastMessage(state: ThreadConsoleState): TranscriptMessageEntry | undefined {
  return messagesOf(state).at(-1);
}

describe("the thread console", () => {
  it("renders token deltas before the run completes", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({
      transcript: [
        textMessage({ id: "message-0", threadId, seq: 0, role: "user", text: "do it", runId }),
      ],
      events: events.procedure,
    });
    const console = consoleFor(transport);

    console.start();
    await until(() => events.calls.length === 1, "the subscription");

    events.push(runStarted(threadId, runId, 1));
    events.push(tokenDelta(threadId, runId, 2, messageId, "Hel"));

    await until(
      () => messagesOf(console.state()).some((entry) => entry.text === "Hel"),
      "the first delta",
    );

    // The screen has the partial text while the run is still open: the client
    // never waits for the completion event to show tokens.
    const streaming = lastMessage(console.state());
    expect(streaming).toMatchObject({ id: messageId, role: "assistant", streaming: true });
    expect(messagesOf(console.state()).map((entry) => entry.text)).toEqual(["do it", "Hel"]);

    events.push(tokenDelta(threadId, runId, 3, messageId, "lo"));
    events.push(runCompleted(threadId, runId, 4, messageId));

    await until(() => !lastMessage(console.state())?.streaming, "the completed run");

    expect(console.state().entries).toEqual([
      { kind: "message", id: "message-0", role: "user", text: "do it", streaming: false },
      { kind: "message", id: messageId, role: "assistant", text: "Hello", streaming: false },
    ]);

    console.stop();
  });

  it("resumes a dropped connection and folds the continuation without duplicating a token", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({ events: events.procedure });
    const phases: string[] = [];
    const console = consoleFor(transport, (state) => {
      if (state.connection !== phases.at(-1)) {
        phases.push(state.connection);
      }
    });

    console.start();
    await until(() => events.calls.length === 1, "the first subscription");

    events.push(runStarted(threadId, runId, 1));
    events.push(tokenDelta(threadId, runId, 2, messageId, "One"));

    await until(() => lastMessage(console.state())?.text === "One", "the first delta");

    events.end();
    await until(() => events.calls.length === 2, "the second subscription");

    events.push(tokenDelta(threadId, runId, 3, messageId, " two"));
    events.push(runCompleted(threadId, runId, 4, messageId));

    await until(() => !lastMessage(console.state())?.streaming, "the completed run");

    expect(phases).toEqual(["connecting", "live", "reconnecting", "connecting", "resumed"]);

    // One message, exactly the text the two attempts produced: no duplicate
    // from a replay and no gap from the drop.
    expect(console.state().entries).toEqual([
      { kind: "message", id: messageId, role: "assistant", text: "One two", streaming: false },
    ]);

    console.stop();
  });

  it("replays from zero after a reload and matches the wire's own snapshot", async () => {
    const started = runStarted(threadId, runId, 1);
    const firstDelta = tokenDelta(threadId, runId, 2, messageId, "Hello");
    const everyEvent = [
      started,
      firstDelta,
      tokenDelta(threadId, runId, 3, messageId, " world"),
      runCompleted(threadId, runId, 4, messageId),
    ];
    const transcript = [
      textMessage({ id: "message-0", threadId, seq: 0, role: "user", text: "say hello", runId }),
      textMessage({ id: messageId, threadId, seq: 1, role: "assistant", text: "Hello world" }),
    ];

    // The first view: two events in, then the tab is gone.
    const before = createScriptedEvents();
    const beforeConsole = consoleFor(
      scriptedThreadTransport({ transcript, events: before.procedure }),
    );

    beforeConsole.start();
    await until(() => before.calls.length === 1, "the first subscription");
    before.push(started);
    before.push(firstDelta);

    await until(() => lastMessage(beforeConsole.state())?.text === "Hello", "the partial text");
    beforeConsole.stop();

    // The reload: a fresh console, an empty snapshot, and the same durable
    // events replayed from seq 0 — the snapshot the wire would have produced.
    const after = createScriptedEvents();
    const afterConsole = consoleFor(
      scriptedThreadTransport({ transcript, events: after.procedure }),
    );

    afterConsole.start();
    await until(() => after.calls.length === 1, "the reload subscription");

    // The reload must not depend on a cursor the old tab held.
    expect(after.calls[0]?.lastEventId).toBeUndefined();

    for (const event of everyEvent) {
      after.push(event);
    }

    await until(() => !lastMessage(afterConsole.state())?.streaming, "the replayed run");

    expect(afterConsole.state().entries).toEqual([
      { kind: "message", id: "message-0", role: "user", text: "say hello", streaming: false },
      { kind: "message", id: messageId, role: "assistant", text: "Hello world", streaming: false },
    ]);

    afterConsole.stop();
  });

  it("shows a typed refusal and starts over on retry", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({ events: events.procedure });
    const console = consoleFor(transport);

    console.start();
    await until(() => events.calls.length === 1, "the subscription");

    events.fail(
      new ORPCError("NOT_FOUND", { defined: true, status: 404, message: "no such thread" }),
    );

    await until(() => console.state().status === "refused", "the refusal");
    expect(console.state().refusal).toBe("This thread is not available.");

    console.retry();

    await until(() => console.state().status === "loading", "the retry's loading state");
    await until(() => events.calls.length === 2, "the retried subscription");

    events.push(runStarted(threadId, runId, 1));
    events.push(tokenDelta(threadId, runId, 2, messageId, "back"));

    await until(() => lastMessage(console.state())?.text === "back", "the retried stream");
    expect(console.state().refusal).toBeNull();

    console.stop();
  });

  it("refuses before subscribing when the transcript is not available", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({
      transcriptFailure: new ORPCError("NOT_FOUND", {
        defined: true,
        status: 404,
        message: "no such thread",
      }),
      events: events.procedure,
    });
    const console = consoleFor(transport);

    console.start();
    await until(() => console.state().status === "refused", "the refusal");
    expect(console.state().refusal).toBe("This thread is not available.");
    expect(events.calls).toHaveLength(0);

    console.stop();
  });

  it("treats a stream contradiction as unreadable rather than repairing it", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({ events: events.procedure });
    const console = consoleFor(transport);

    console.start();
    await until(() => events.calls.length === 1, "the subscription");

    events.push({
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      seq: 1,
      threadId,
      runId,
      type: "tool.completed",
      callId: "call-unknown",
      result: {},
    });

    await until(() => console.state().status === "refused", "the refusal");
    expect(console.state().refusal).toBe("The stream could not be read.");

    console.stop();
  });

  it("does not let a slow transcript fetch from before a retry overwrite the retry's", async () => {
    const events = createScriptedEvents();
    const before = textMessage({ id: "user-0", threadId, seq: 0, role: "user", text: "before" });
    const after = textMessage({ id: "user-1", threadId, seq: 1, role: "user", text: "after" });
    let release: (messages: readonly Message[]) => void = () => undefined;
    const slow = new Promise<readonly Message[]>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const transport = {
      ...scriptedThreadTransport({ events: events.procedure }),
      transcript: async (): Promise<readonly Message[]> => {
        calls += 1;

        return calls === 1 ? slow : [after];
      },
    };
    const console = consoleFor(transport);

    console.start();
    await until(() => calls === 1, "the slow transcript fetch");

    // The retry starts a second fetch while the first is still in flight.
    console.retry();
    await until(
      () => messagesOf(console.state()).at(0)?.text === "after",
      "the retry's transcript",
    );

    // The stale fetch resolves last; it must not replace the transcript a
    // later frame would then merge into the rendered entries.
    release([before]);
    await until(() => events.calls.length >= 1, "the retried subscription");

    events.push(runStarted(threadId, runId, 1));
    events.push(tokenDelta(threadId, runId, 2, messageId, "live"));

    await until(() => lastMessage(console.state())?.text === "live", "the live frame");

    expect(messagesOf(console.state()).map((entry) => entry.text)).toEqual(["after", "live"]);

    console.stop();
  });

  it("keeps a persisted message it cannot read as a turn with no text", async () => {
    const events = createScriptedEvents();
    const unreadable = {
      ...textMessage({ id: "message-0", threadId, seq: 0, role: "user", text: "" }),
      blocks: [{ type: "image", url: "https://example.invalid/image.png" }],
    } as unknown as Message;
    const transport = scriptedThreadTransport({
      transcript: [unreadable],
      events: events.procedure,
    });
    const console = consoleFor(transport);

    console.start();
    await until(() => console.state().status === "ready", "the transcript");
    await until(() => events.calls.length === 1, "the subscription");

    expect(console.state().entries).toEqual([
      { kind: "message", id: "message-0", role: "user", text: "", streaming: false },
    ]);

    console.stop();
  });

  it("ignores frames that arrive after stop", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({ events: events.procedure });
    const console = consoleFor(transport);

    console.start();
    await until(() => events.calls.length === 1, "the subscription");

    console.stop();
    events.push(runStarted(threadId, runId, 1));
    events.push(tokenDelta(threadId, runId, 2, messageId, "late"));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(console.state().entries).toEqual([]);
  });

  it("renders a run's tool calls between its prompt and its answer, as the replay does", async () => {
    const transcript = [
      textMessage({ id: "message-0", threadId, seq: 0, role: "user", text: "audit it", runId }),
    ];
    const everyEvent: RunEvent[] = [
      runStarted(threadId, runId, 1),
      toolRequested(threadId, runId, 2, "call-1", "shell", {
        command: "ls",
        token: "[redacted]",
      }),
      toolCompleted(threadId, runId, 3, "call-1", "x".repeat(4_096), {
        durationMs: 120,
        resultArtifact: { kind: "tool_call", callId: "call-1", bytes: 4_096 },
      }),
      toolRequested(threadId, runId, 4, "call-2", "rm", { path: "/etc" }),
      toolFailed(threadId, runId, 5, "call-2", 'tool "rm" failed (timed_out): no answer', 30_000),
      tokenDelta(threadId, runId, 6, messageId, "Done"),
      runCompleted(threadId, runId, 7, messageId),
    ];
    const events = createScriptedEvents();
    const console = consoleFor(scriptedThreadTransport({ transcript, events: events.procedure }));

    console.start();
    await until(() => events.calls.length === 1, "the subscription");

    for (const event of everyEvent) {
      events.push(event);
    }

    await until(() => lastMessage(console.state())?.text === "Done", "the completed run");

    // The live view is exactly the reduced state's own reading: a reload that
    // replays the same rows renders this same function of this same snapshot,
    // so the two views cannot diverge.
    const reduced = reduceRunEvents(createThreadSnapshot(threadId), everyEvent);
    expect(reduced.ok).toBe(true);
    const rendered = reduced.ok ? mergeTranscript(transcript, reduced.snapshot) : [];

    expect(console.state().entries).toEqual(rendered);
    expect(
      console
        .state()
        .entries.map((entry) =>
          entry.kind === "tool" ? `tool:${entry.call.tool}` : `${entry.role}:${entry.text}`,
        ),
    ).toEqual(["user:audit it", "tool:shell", "tool:rm", "assistant:Done"]);

    const tools = console.state().entries.filter((entry) => entry.kind === "tool");

    expect(tools[0]).toMatchObject({
      runId,
      call: {
        callId: "call-1",
        status: "completed",
        durationMs: 120,
        arguments: { command: "ls", token: "[redacted]" },
        resultArtifact: { kind: "tool_call", callId: "call-1", bytes: 4_096 },
      },
    });
    expect(tools[1]).toMatchObject({
      call: {
        callId: "call-2",
        status: "failed",
        error: 'tool "rm" failed (timed_out): no answer',
        durationMs: 30_000,
      },
    });

    console.stop();
  });
});

describe("the console's liveness follow", () => {
  const runIdle = "run-2";
  const assessment = {
    id: runId,
    status: "running",
    liveness: {
      state: "working",
      tool: "shell",
      heartbeatLagMs: 3_000,
      sinceProgressMs: 10_000,
    },
  } as const;

  function livenessConsole(
    transport: Parameters<typeof createThreadConsole>[0]["transport"],
    intervalMs = 5,
  ) {
    return createThreadConsole({
      transport,
      threadId,
      livenessIntervalMs: intervalMs,
      policy: pinnedPolicy,
      sleep: async () => undefined,
    });
  }

  it("reads the active run's assessment and clears it when the run settles", async () => {
    const events = createScriptedEvents();
    const scripted = scriptedThreadTransport({
      transcript: [
        textMessage({ id: "message-0", threadId, seq: 0, role: "user", text: "do it", runId }),
      ],
      events: events.procedure,
      runs: { [runId]: assessment },
    });
    const console = livenessConsole(scripted);

    console.start();
    await until(() => events.calls.length === 1, "the subscription");

    events.push(runStarted(threadId, runId, 1));

    await until(() => console.state().liveness !== null, "the liveness read");
    expect(console.state().liveness).toEqual(assessment.liveness);
    expect(scripted.runCalls).toEqual([runId]);

    // The run settles: the same fold that ends the run ends the poll, and the
    // line clears rather than showing a finished run as working.
    events.push(runCompleted(threadId, runId, 2, messageId));
    await until(() => console.state().liveness === null, "the liveness to clear");

    const reads = scripted.runCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scripted.runCalls).toHaveLength(reads);

    console.stop();
  });

  it("clears the line and stops polling a run the API no longer has", async () => {
    const events = createScriptedEvents();
    let reads = 0;
    const scripted = scriptedThreadTransport({
      events: events.procedure,
      // The row exists for the first read and is gone after it, the way a
      // reaped or rolled-back row disappears between two polls.
      runs: () => (reads++ === 0 ? { [runId]: assessment } : {}),
    });
    const console = livenessConsole(scripted);

    console.start();
    await until(() => events.calls.length === 1, "the subscription");

    events.push(runStarted(threadId, runId, 1));

    await until(() => scripted.runCalls.length >= 2, "the second liveness read");
    await until(() => console.state().liveness === null, "the liveness to clear");
    const calls = scripted.runCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(scripted.runCalls).toHaveLength(calls);
    expect(console.state().status).toBe("ready");

    console.stop();
  });

  it("follows a later run in the same thread once the first settled", async () => {
    const events = createScriptedEvents();
    const scripted = scriptedThreadTransport({
      events: events.procedure,
      runs: {
        [runId]: { id: runId, status: "completed", liveness: null },
        [runIdle]: {
          id: runIdle,
          status: "running",
          liveness: {
            state: "thinking",
            tool: null,
            heartbeatLagMs: 1_000,
            sinceProgressMs: 2_000,
          },
        },
      },
    });
    const console = livenessConsole(scripted);

    console.start();
    await until(() => events.calls.length === 1, "the subscription");

    events.push(runStarted(threadId, runId, 1));
    events.push(runCompleted(threadId, runId, 2, messageId));
    events.push(runStarted(threadId, runIdle, 3));

    await until(() => console.state().liveness?.state === "thinking", "the second run's liveness");
    expect(scripted.runCalls).toContain(runIdle);

    console.stop();
  });
});
