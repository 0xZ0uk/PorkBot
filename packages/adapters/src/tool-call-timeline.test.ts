import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { createThreadSnapshot, reduceRunEvents } from "@porkbot/core";
import type { RunEvent, ToolCallSnapshot } from "@porkbot/core";
import { createRunEventRecorder, LiveRuns, liveRunsLayer, withLiveRun } from "@porkbot/effect";
import type {
  LiveRunsShape,
  LiveRunsTag,
  RunGoneError,
  RunSession,
  RunStartRequest,
} from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import { emulatorAgentRuntimeLayer } from "./agent-runtime-emulator.ts";
import type { EmulatorStep } from "./agent-runtime-emulator.ts";

/**
 * The tool-call lifecycle as a session emits it (slice 5.6): the shipped
 * offline runtime produces requested/completed/failed frames for every tool,
 * the recorder turns them into the durable-and-live shape — redacted
 * arguments, a bounded result with an artifact pointer, a measured duration —
 * and the core reducer folds both streams into the same timeline. The
 * sanitized stream is what a client sees live and after a reload, so this is
 * the property the slice is about: recording never changes which call
 * happened, only how much of it is carried inline.
 */

const limits = { maxInlineBytes: 256, previewBytes: 64 };

function startRequest(runId: string): RunStartRequest {
  return {
    runId,
    threadId: "thread-1",
    startSeq: 1,
    connection: { baseUrl: "https://model.example.test/v1", credentialName: "model-key" },
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  };
}

/**
 * Runs one scripted session, records every frame on its way to the collector,
 * and returns the raw and the recorded stream. The clock bumps on every read,
 * so each requested/settled pair is deterministically one tick apart.
 */
function driveRecordedRun(
  runId: string,
  script: readonly EmulatorStep[],
  send?: (liveRuns: LiveRunsShape) => Effect.Effect<void, RunGoneError>,
): Effect.Effect<
  { readonly wire: readonly RunEvent[]; readonly recorded: readonly RunEvent[] },
  RunGoneError,
  Scope.Scope | LiveRunsTag
> {
  return Effect.gen(function* () {
    let now = 0;
    const recorder = createRunEventRecorder({ clock: () => (now += 100), limits });
    const session = yield* Deferred.make<RunSession>();
    const release = yield* Deferred.make<undefined>();

    const run = yield* Effect.fork(
      withLiveRun(runId, emulatorAgentRuntimeLayer(startRequest(runId), script), (live) =>
        Deferred.succeed(session, live).pipe(Effect.zipRight(Deferred.await(release))),
      ),
    );

    const live = yield* Deferred.await(session);
    const wire = yield* Queue.unbounded<RunEvent>();
    const recorded = yield* Queue.unbounded<RunEvent>();
    const collector = yield* Effect.fork(
      Stream.runForEach(live.events, (event) =>
        Queue.offer(wire, event).pipe(
          Effect.zipRight(Queue.offer(recorded, recorder.record(event))),
        ),
      ),
    );

    const liveRuns = yield* LiveRuns;
    if (send !== undefined) {
      yield* send(liveRuns);
    }

    yield* Fiber.join(collector);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(run);

    return {
      wire: Array.from(yield* Queue.takeAll(wire)),
      recorded: Array.from(yield* Queue.takeAll(recorded)),
    };
  });
}

function timelineOf(events: readonly RunEvent[]): readonly ToolCallSnapshot[] {
  const reduced = reduceRunEvents(createThreadSnapshot("thread-1"), events);
  expect(reduced.ok).toBe(true);
  return reduced.ok ? (reduced.snapshot.runs[0]?.toolCalls ?? []) : [];
}

describe("the tool-call lifecycle through the offline runtime", () => {
  it("carries every call from requested to a recorded completion or failure", async () => {
    const script: readonly EmulatorStep[] = [
      {
        kind: "tool.immediate",
        callId: "call-ok",
        tool: "shell",
        arguments: { command: "echo hi", apiKey: "sk-live-0123456789" },
        result: { stdout: "x".repeat(4_096) },
      },
      {
        kind: "tool.awaiting_approval",
        callId: "call-denied",
        tool: "rm",
        arguments: { path: "/etc" },
        result: "removed",
      },
      { kind: "run.completed", messageId: "assistant-1" },
    ];

    const { recorded } = await Effect.runPromise(
      driveRecordedRun("run-1", script, (liveRuns) =>
        liveRuns.dispatch("run-1", { type: "deny", callId: "call-denied", reason: "not allowed" }),
      ).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    expect(recorded.map((event) => event.type)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "tool.requested",
      "tool.failed",
      "run.completed",
    ]);

    const requested = recorded[1];
    expect(requested).toMatchObject({
      callId: "call-ok",
      tool: "shell",
      arguments: { command: "echo hi", apiKey: "[redacted]" },
    });

    const completed = recorded[2];
    expect(completed).toMatchObject({
      callId: "call-ok",
      durationMs: 100,
      resultArtifact: { kind: "tool_call", callId: "call-ok" },
    });

    const completedResult = completed?.type === "tool.completed" ? completed.result : undefined;
    expect(String(completedResult)).toContain("[truncated]");

    expect(recorded[4]).toMatchObject({
      callId: "call-denied",
      error: "not allowed",
      durationMs: 100,
    });
  });

  it("reduces to the same timeline the wire showed", async () => {
    const script: readonly EmulatorStep[] = [
      {
        kind: "tool.immediate",
        callId: "call-ok",
        tool: "shell",
        arguments: { command: "echo hi", token: "sk-live-0123456789" },
        result: { stdout: "x".repeat(4_096) },
      },
      {
        kind: "tool.awaiting_approval",
        callId: "call-denied",
        tool: "rm",
        arguments: {},
        result: "removed",
      },
      { kind: "run.completed", messageId: "assistant-1" },
    ];

    const { wire, recorded } = await Effect.runPromise(
      driveRecordedRun("run-1", script, (liveRuns) =>
        liveRuns.dispatch("run-1", { type: "deny", callId: "call-denied" }),
      ).pipe(Effect.scoped, Effect.provide(liveRunsLayer)),
    );

    const shape = (calls: readonly ToolCallSnapshot[]) =>
      calls.map((call) => ({ callId: call.callId, tool: call.tool, status: call.status }));

    expect(shape(timelineOf(recorded))).toEqual(shape(timelineOf(wire)));
    expect(timelineOf(recorded).map((call) => call.status)).toEqual(["completed", "failed"]);
    expect(timelineOf(recorded)[0]?.arguments).toMatchObject({ token: "[redacted]" });
    expect(timelineOf(recorded)[1]).not.toHaveProperty("resultArtifact");
  });
});
