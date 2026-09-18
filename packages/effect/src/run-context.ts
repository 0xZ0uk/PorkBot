import { Effect } from "effect";
import { composeRunPrompt } from "@porkbot/core";
import type { PromptBotIdentity, PromptSection, RecallLimits, RunPrompt } from "@porkbot/core";
import type { MemoryReader } from "./memory-store.ts";

/**
 * The run's prompt, loaded and composed (slice 8.2, PRD decision 21).
 *
 * A run's system prompt is not assembled where the run is wired: the memory
 * lane is read through the actor-scoped `MemoryReader`, and the composition
 * itself is `composeRunPrompt` from `@porkbot/core`, so the identity, the
 * instructions, the deployment's sections and the bounded memory lane reach the
 * composer and nowhere else. This module is the one place that pairs the read
 * with the composition, so a caller that starts a run cannot grow a second,
 * quietly different prompt path.
 *
 * The read is scoped: a bot outside the actor's space lists nothing, exactly
 * like a bot with no documents, so the prompt of a foreign bot is never built.
 */

export interface LoadRunPromptInput {
  readonly bot: PromptBotIdentity;
  readonly instructions?: string | undefined;
  readonly sections?: readonly PromptSection[] | undefined;
  readonly limits?: RecallLimits | undefined;
}

export function loadRunPrompt(
  reader: MemoryReader,
  botId: string,
  input: LoadRunPromptInput,
): Effect.Effect<RunPrompt> {
  return Effect.promise(() => reader.list(botId)).pipe(
    Effect.map((memory) => composeRunPrompt({ ...input, memory })),
  );
}
