import { Effect, Stream } from "effect";
import { createThreadSnapshot, reduceRunEvents } from "@porkbot/core";
import type { RunEvent, ThreadSnapshot } from "@porkbot/core";
import { AgentRuntime } from "@porkbot/effect";
import type { RunStartRequest } from "@porkbot/effect";
import { piAgentRuntimeLayer, recordedPiRunSource } from "../pi-run-source.ts";

/**
 * Replays one recorded Pi session through the shipped adapter and reduces the
 * emitted `RunEvent`s, exactly as a client would. The corpus test asserts the
 * reduced snapshot, so a change in Pi's event shape, the mapping table or the
 * reducer all surface as one reviewable diff.
 */

export const PI_CORPUS_THREAD_ID = "thread-pi-corpus";
export const PI_CORPUS_RUN_ID = "run-pi-corpus";

export function piCorpusStartRequest(): RunStartRequest {
  return {
    runId: PI_CORPUS_RUN_ID,
    threadId: PI_CORPUS_THREAD_ID,
    startSeq: 1,
    connection: { baseUrl: "https://model.example.test/v1", credentialName: "corpus-model-key" },
    model: "corpus-model",
    messages: [{ role: "user", content: "replay" }],
  };
}

/** Drives the recorded events through `piAgentRuntimeLayer` and collects the wire events. */
export async function replayPiCorpus(events: readonly unknown[]): Promise<readonly RunEvent[]> {
  const program = Effect.gen(function* () {
    const { session } = yield* AgentRuntime;
    return yield* Stream.runCollect(session.events);
  }).pipe(Effect.provide(piAgentRuntimeLayer(piCorpusStartRequest(), recordedPiRunSource(events))));

  return Array.from(await Effect.runPromise(Effect.scoped(program)));
}

/** Reduces the replayed events into the thread snapshot a client renders. */
export function reducePiCorpus(events: readonly RunEvent[]): ThreadSnapshot {
  const result = reduceRunEvents(createThreadSnapshot(PI_CORPUS_THREAD_ID), events);

  if (!result.ok) {
    throw result.error;
  }

  return result.snapshot;
}
