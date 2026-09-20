import { Effect } from "effect";
import { createLiveAgentRuntimeLayer, createOpenAiCompatibleModelRuntime } from "@porkbot/adapters";
import type { ModelRuntimeProvider } from "@porkbot/adapter-kit";
import {
  consumeRunSession,
  createRunEventRecorder,
  liveRunsLayer,
  loadRunPrompt,
  pumpRunCommands,
  withLiveRun,
} from "@porkbot/effect";
import type { RunEventSink } from "@porkbot/effect";
import { buildRunConversation, ConversationUnavailableError } from "./run-conversation.ts";
import type { RunWork } from "./run-execution.ts";

/**
 * The live model launch (slice 6.11): the worker's work seam filled with the
 * operator's own model connection.
 *
 * Everything the run is assembled from is already durable and scoped: the
 * bot's identity and instructions, the thread's conversation rebuilt from the
 * event stream, the model connection and its credential name, and the memory
 * lane read through the job's repository. The launch resolves those, composes
 * the prompt with `composeRunPrompt`, starts the live runtime seam beside the
 * run's repositories, drains the session's events through the recorder into
 * the `event` sink, and forwards the operator's durable steers and stop mark
 * into the live session.
 *
 * The run's settlement is the session's own terminal event, and the executor
 * around this maps the returned outcome onto the row: a session that completed
 * closes the run, one the operator cancelled settles `cancelled`, and one that
 * failed carries the classified sentence the model endpoint produced. A run
 * that cannot be assembled — no connection selected, a transcript too large
 * to replay, no operator message to answer — fails with a sentence the
 * operator can act on rather than settling quietly.
 *
 * No tool is registered yet: this slice is the conversation. Tools join the
 * same dispatcher seam next, and the run's event stream is the transcript the
 * console already renders.
 */

export interface LiveRunOptions {
  /**
   * The run's model provider. The composition root leaves this unset and the
   * deployment's OpenAI-compatible runtime is built per run over the job's
   * credential store; the offline suites inject the emulator.
   */
  readonly modelRuntime?: ModelRuntimeProvider | undefined;
  /**
   * How often the session re-reads the durable steer and stop marks; defaults
   * to the command pump's own interval. It is a latency knob, never a
   * correctness one — both commands are rows before they are mailbox entries.
   */
  readonly commandPollIntervalMs?: number | undefined;
}

export function createLiveRunWork(options: LiveRunOptions = {}): RunWork {
  return (execution) =>
    Effect.gen(function* () {
      const { run, repositories } = execution;
      const selection = yield* read(() => repositories.modelConnections.resolveForBot(run.botId));

      if (selection === undefined) {
        return yield* Effect.fail(
          new Error(
            "This bot has no model connection selected, so the run has nothing to answer with.",
          ),
        );
      }

      const bot = yield* read(() => repositories.bots.findById(run.botId));
      const thread = yield* read(() => repositories.threads.findById(run.threadId));
      const conversation = yield* read(() =>
        buildRunConversation(
          {
            messages: repositories.messages,
            events: repositories.events,
            runs: repositories.runs,
          },
          run.threadId,
          run.id,
        ),
      );
      const prompt = yield* loadRunPrompt(repositories.memory, run.botId, {
        bot: { name: bot.name, title: bot.title, description: bot.description },
        instructions: bot.instructions,
      });
      const runtime =
        options.modelRuntime ??
        createOpenAiCompatibleModelRuntime({ credentials: repositories.credentials });
      const layer = createLiveAgentRuntimeLayer({
        runtime,
        connection: { baseUrl: selection.baseUrl, credentialName: selection.credentialName },
        model: selection.model,
        runId: run.id,
        threadId: run.threadId,
        // The thread's counter is the count of events written so far, and its
        // sequence is 1-based, so an untouched thread starts at 1.
        startSeq: Math.max(1, thread.nextEventSeq),
        systemPrompt: prompt.systemPrompt,
        history: conversation.history,
        prompt: conversation.prompt,
        usage: repositories.usage,
      });
      const recorder = createRunEventRecorder();
      const sink: RunEventSink = repositories.events;

      return yield* withLiveRun(run.id, layer, (session) =>
        Effect.all(
          [
            consumeRunSession(session, (event) => record(sink, recorder.record(event))),
            pumpRunCommands(session, {
              runId: run.id,
              source: repositories.commands,
              ...(options.commandPollIntervalMs === undefined
                ? {}
                : { pollIntervalMs: options.commandPollIntervalMs }),
            }),
          ],
          { concurrency: 2 },
        ).pipe(Effect.map(([outcome]) => outcome)),
      ).pipe(Effect.provide(liveRunsLayer));
    });
}

function read<A>(load: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: load,
    catch: (cause) =>
      // A transcript the run cannot answer with carries a sentence the
      // operator can act on; a storage failure says only that the context
      // could not be read, because the database's own text is not ours to
      // surface.
      cause instanceof ConversationUnavailableError
        ? cause
        : new Error("the run's context could not be read", { cause }),
  });
}

function record(sink: RunEventSink, event: Parameters<RunEventSink["append"]>[0]) {
  return Effect.tryPromise({
    try: () => sink.append(event),
    catch: (cause) => new Error("this run's event stream could not be recorded", { cause }),
  });
}
