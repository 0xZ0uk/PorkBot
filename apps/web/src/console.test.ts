import { ORPCError } from "@porkbot/contracts";
import type { Message } from "@porkbot/contracts";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import {
  createScriptedEvents,
  runCompleted,
  runStarted,
  scriptedThreadTransport,
  textMessage,
  tokenDelta,
} from "../test/fakes.ts";
import { createThreadConsole } from "./console.ts";
import type { ThreadConsoleState } from "./console.ts";

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
      () => console.state().entries.some((entry) => entry.text === "Hel"),
      "the first delta",
    );

    // The screen has the partial text while the run is still open: the client
    // never waits for the completion event to show tokens.
    const streaming = console.state().entries.at(-1);
    expect(streaming).toMatchObject({ id: messageId, role: "assistant", streaming: true });
    expect(console.state().entries.map((entry) => entry.text)).toEqual(["do it", "Hel"]);

    events.push(tokenDelta(threadId, runId, 3, messageId, "lo"));
    events.push(runCompleted(threadId, runId, 4, messageId));

    await until(() => !console.state().entries.at(-1)?.streaming, "the completed run");

    expect(console.state().entries).toEqual([
      { id: "message-0", role: "user", text: "do it", streaming: false },
      { id: messageId, role: "assistant", text: "Hello", streaming: false },
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

    await until(() => console.state().entries.at(-1)?.text === "One", "the first delta");

    events.end();
    await until(() => events.calls.length === 2, "the second subscription");

    events.push(tokenDelta(threadId, runId, 3, messageId, " two"));
    events.push(runCompleted(threadId, runId, 4, messageId));

    await until(() => !console.state().entries.at(-1)?.streaming, "the completed run");

    expect(phases).toEqual(["connecting", "live", "reconnecting", "connecting", "resumed"]);

    // One message, exactly the text the two attempts produced: no duplicate
    // from a replay and no gap from the drop.
    expect(console.state().entries).toEqual([
      { id: messageId, role: "assistant", text: "One two", streaming: false },
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

    await until(() => beforeConsole.state().entries.at(-1)?.text === "Hello", "the partial text");
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

    await until(() => !afterConsole.state().entries.at(-1)?.streaming, "the replayed run");

    expect(afterConsole.state().entries).toEqual([
      { id: "message-0", role: "user", text: "say hello", streaming: false },
      { id: messageId, role: "assistant", text: "Hello world", streaming: false },
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

    await until(() => console.state().entries.at(-1)?.text === "back", "the retried stream");
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
    await until(() => console.state().entries.at(0)?.text === "after", "the retry's transcript");

    // The stale fetch resolves last; it must not replace the transcript a
    // later frame would then merge into the rendered entries.
    release([before]);
    await until(() => events.calls.length >= 1, "the retried subscription");

    events.push(runStarted(threadId, runId, 1));
    events.push(tokenDelta(threadId, runId, 2, messageId, "live"));

    await until(() => console.state().entries.at(-1)?.text === "live", "the live frame");

    expect(console.state().entries.map((entry) => entry.text)).toEqual(["after", "live"]);

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
      { id: "message-0", role: "user", text: "", streaming: false },
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
});
