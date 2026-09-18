import { NotFoundError } from "@porkbot/effect";
import type { RunEvent } from "@porkbot/core";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import type { SystemActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { createRunEventSink } from "./run-event-sink.ts";

/**
 * The event sink without a server: a recording fake stands in for the pg
 * client, so these tests prove the module's own contract — one statement
 * appends the row and advances the thread's counter, the base fields live in
 * columns rather than the payload, and a thread or run outside the actor's
 * space writes nothing and answers the typed not-found. Whether the SQL is
 * valid against Postgres is the integration suite's half.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
}

function fakeDatabase(respond: (call: QueryCall) => readonly unknown[]): FakeDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      const call = { text, values };
      calls.push(call);

      return { rows: respond(call) as readonly Row[] };
    },
  };
}

const worker: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };

const base = {
  schemaVersion: RUN_EVENT_SCHEMA_VERSION,
  threadId: "thread-1",
  runId: "run-1",
} as const;

const appended = (database: FakeDatabase): readonly QueryCall[] =>
  database.calls.filter(({ text }) => text.startsWith("with allocated as"));

describe("appending an event", () => {
  it("writes the row and advances the thread's counter in one scoped statement", async () => {
    const database = fakeDatabase(() => [{ id: "event-1" }]);
    const sink = createRunEventSink(worker, database);
    const event: RunEvent = {
      ...base,
      seq: 4,
      type: "tool.completed",
      callId: "call-1",
      result: "preview [truncated]",
      resultArtifact: { kind: "tool_call", callId: "call-1", bytes: 9_999 },
      durationMs: 320,
    };

    await sink.append(event);

    expect(database.calls).toHaveLength(1);
    const [call] = appended(database);
    expect(call?.text).toContain("update thread set next_event_seq = greatest(");
    expect(call?.text).toContain("r.thread_id = $2");
    expect(call?.text).toContain("insert into event");
    expect(call?.values).toEqual([
      "space-1",
      "thread-1",
      4,
      "tool.completed",
      JSON.stringify({
        callId: "call-1",
        result: "preview [truncated]",
        resultArtifact: { kind: "tool_call", callId: "call-1", bytes: 9_999 },
        durationMs: 320,
      }),
      "run-1",
    ]);
  });

  it("stores the event's own payload fields and never the base fields", async () => {
    const database = fakeDatabase(() => [{ id: "event-1" }]);
    const sink = createRunEventSink(worker, database);

    await sink.append({ ...base, seq: 1, type: "run.started" });
    await sink.append({
      ...base,
      seq: 2,
      type: "token.delta",
      messageId: "message-1",
      delta: "hi",
    });

    expect(JSON.parse(String(appended(database)[0]?.values[4]))).toEqual({});
    expect(JSON.parse(String(appended(database)[1]?.values[4]))).toEqual({
      messageId: "message-1",
      delta: "hi",
    });
  });
});

describe("appending outside the actor's space", () => {
  it("writes nothing and names the thread when the thread is not in the space", async () => {
    const database = fakeDatabase(() => []);
    const sink = createRunEventSink(worker, database);
    const event: RunEvent = { ...base, seq: 1, type: "run.started" };

    const error = await sink.append(event).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).resource).toBe("thread");
    expect(appended(database)).toHaveLength(1);

    const read = database.calls.filter(({ text }) => text.startsWith("select id from thread"));
    expect(read).toHaveLength(1);
    expect(read[0]?.values).toEqual(["thread-1", "space-1"]);
  });

  it("writes nothing and names the run when the thread is visible but the run is not", async () => {
    const database = fakeDatabase((call) =>
      call.text.startsWith("with allocated as") ? [] : [{ id: "thread-1" }],
    );
    const sink = createRunEventSink(worker, database);
    const event: RunEvent = { ...base, seq: 1, type: "run.started" };

    await expect(sink.append(event)).rejects.toMatchObject({
      _tag: "NotFoundError",
      resource: "run",
    });
  });
});
