import { Data, Effect } from "effect";
import { assertMemoryPreserved, compactionSummaryRequest, planCompaction } from "@porkbot/core";
import type { ConversationMessage, MemoryDocument } from "@porkbot/core";
import { isProviderFailure } from "@porkbot/adapter-kit";
import type { ModelConnection, ModelRuntimeProvider, ProviderFailure } from "@porkbot/adapter-kit";
import type { MemoryReader } from "./memory-store.ts";

/**
 * Automatic conversation compaction (slice 8.2, PRD decision 21; story 23).
 *
 * The conversation lane is the one that gets compacted. `planCompaction` in
 * `@porkbot/core` decides what stays verbatim and what is summarised, and
 * `compactionSummaryRequest` renders the one deterministic turn the model
 * receives. This module is the orchestration around both: it loads the memory
 * lane — read-only, through the actor-scoped reader — plans, asks the model for
 * the summary, and returns the shortened conversation beside the memory lane
 * it started with. The plan carries the memory documents by reference and
 * `assertMemoryPreserved` runs before the model is asked anything, so the two
 * lanes cannot overwrite each other: a summary changes what the conversation
 * says, never what the bot durably knows.
 *
 * The summary turn is the only model call, and it happens only when there is
 * something to summarise; a history inside the keep window produces no request
 * at all. The provider is the same `ModelRuntimeProvider` every run uses, so
 * the offline emulator makes compaction deterministic and testable with no
 * keys, and a provider failure is the shared `ProviderFailure` the run's
 * lifecycle already branches on.
 *
 * A summary the model did not actually produce — an empty one, a turn that
 * called a tool, a turn truncated by the model's length limit, a stream that
 * ended early — is the typed `CompactionFailure` rather than a
 * reasonable-looking empty string, because silently passing the uncompacted
 * history off as compacted is the bug this rejects.
 *
 * The plan's conversation vocabulary is `user` and `assistant` turns; a run
 * whose history also carries tool or system turns renders them into that
 * vocabulary (or filters them) before this service, because a role the plan
 * does not know fails loudly rather than being summarised as prose.
 */

export type CompactionFailureReason =
  "empty_summary" | "summary_tool_call" | "summary_incomplete" | "summary_truncated";

/**
 * The model produced no usable summary. It is deliberately not one of the
 * shared `TypedError`s: a compaction never crosses the transport boundary, and
 * the run's executor decides whether to retry, degrade to the uncompacted
 * history or fail the run.
 */
export class CompactionFailure extends Data.TaggedError("CompactionFailure")<{
  readonly reason: CompactionFailureReason;
  readonly message: string;
}> {
  constructor(reason: CompactionFailureReason) {
    super({ reason, message: compactionFailureMessage(reason) });
  }
}

function compactionFailureMessage(reason: CompactionFailureReason): string {
  switch (reason) {
    case "empty_summary":
      return "the model returned an empty summary";
    case "summary_tool_call":
      return "the model called a tool while summarising a conversation";
    case "summary_incomplete":
      return "the model stream ended before the summary was complete";
    case "summary_truncated":
      return "the model hit its length limit before finishing the summary";
  }
}

export interface ConversationCompactorOptions {
  /** Loads the memory lane; a listing is scoped and never confirms a foreign bot. */
  readonly reader: MemoryReader;
  readonly runtime: ModelRuntimeProvider;
  readonly connection: ModelConnection;
  readonly model: string;
  /** How many of the newest messages stay verbatim; the rest are summarised. */
  readonly keepRecentMessages: number;
}

export interface CompactionInput {
  readonly botId: string;
  /** Conversation history, oldest first. */
  readonly messages: readonly ConversationMessage[];
}

export interface CompactionOutcome {
  /** The summary text, or `null` when nothing needed summarising. */
  readonly summary: string | null;
  /** The ids folded into the summary, oldest first. */
  readonly summarisedMessageIds: readonly string[];
  /** Newest messages kept verbatim, oldest first. */
  readonly keptMessages: readonly ConversationMessage[];
  /** The memory lane, read fresh and passed through untouched. */
  readonly memoryDocuments: readonly MemoryDocument[];
}

export interface ConversationCompactor {
  compact(
    input: CompactionInput,
  ): Effect.Effect<CompactionOutcome, CompactionFailure | ProviderFailure>;
}

function classified(error: unknown): error is CompactionFailure | ProviderFailure {
  return error instanceof CompactionFailure || isProviderFailure(error);
}

async function summaryText(
  runtime: ModelRuntimeProvider,
  connection: ModelConnection,
  model: string,
  request: ReturnType<typeof compactionSummaryRequest>,
): Promise<string> {
  let text = "";

  for await (const event of runtime.stream({ connection, model, messages: request })) {
    switch (event.type) {
      case "text.delta":
        text += event.delta;
        break;
      case "tool.requested":
        throw new CompactionFailure("summary_tool_call");
      case "completed":
        // Only a natural stop is a summary. A turn that hit its length limit
        // is truncated and a turn that finished for tool calls without the
        // call event is malformed; neither may pass as compacted history.
        if (event.finishReason === "tool_calls") {
          throw new CompactionFailure("summary_tool_call");
        }

        if (event.finishReason !== "stop") {
          throw new CompactionFailure("summary_truncated");
        }

        return text;
      default:
        break;
    }
  }

  throw new CompactionFailure("summary_incomplete");
}

export function createConversationCompactor(
  options: ConversationCompactorOptions,
): ConversationCompactor {
  const compact: ConversationCompactor["compact"] = (input) =>
    Effect.gen(function* () {
      const memoryDocuments = yield* Effect.promise(() => options.reader.list(input.botId));

      const plan = planCompaction({
        messages: input.messages,
        memoryDocuments,
        keepRecentMessages: options.keepRecentMessages,
      });

      // The check runs before the model is asked anything: a plan that lost or
      // rewrote a document must never cost a request, let alone a summary.
      assertMemoryPreserved(memoryDocuments, plan.memoryDocuments);

      if (plan.summarisedMessageIds.length === 0) {
        return {
          summary: null,
          summarisedMessageIds: [],
          keptMessages: plan.keptMessages,
          memoryDocuments: plan.memoryDocuments,
        } satisfies CompactionOutcome;
      }

      const raw = yield* Effect.tryPromise({
        try: () =>
          summaryText(
            options.runtime,
            options.connection,
            options.model,
            compactionSummaryRequest(input.messages, plan),
          ),
        catch: (error) => error,
      }).pipe(
        Effect.catchAll((error) => (classified(error) ? Effect.fail(error) : Effect.die(error))),
      );

      const summary = raw.trim();

      if (summary === "") {
        return yield* Effect.fail(new CompactionFailure("empty_summary"));
      }

      return {
        summary,
        summarisedMessageIds: plan.summarisedMessageIds,
        keptMessages: plan.keptMessages,
        memoryDocuments: plan.memoryDocuments,
      } satisfies CompactionOutcome;
    });

  return { compact };
}
