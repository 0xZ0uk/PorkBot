/**
 * One run's prompt: the bot, its instructions, the deployment's sections and
 * the bounded memory lane, assembled by the composer.
 *
 * PRD decision 21 gives a run two lanes, and the prompt is where the memory
 * lane enters it. This module is the single path: it selects memory within
 * `RecallLimits`, hands the selection to `composeSystemPrompt`, and returns
 * both the rendered text and the composed plan, so a caller that wants to know
 * what memory made it into the prompt reads `memory.omitted` instead of
 * parsing the text. Nothing here builds a prompt by concatenation; the
 * composer owns the frame, the data-channel notice and the reserved-section
 * refusals, and this module only decides which documents reach it.
 *
 * The function is pure. Loading documents from the store is the caller's
 * business, which is what keeps the domain free of I/O and lets a test prove
 * the prompt's shape over a fixed list.
 */

import type { UntrustedContent } from "./ingestion.ts";
import { untrustedPromptSection } from "./ingestion.ts";
import type { MemoryDocument } from "./memory-rules.ts";
import type { ComposedPrompt, PromptBotIdentity, PromptSection } from "./prompt-composition.ts";
import { composeSystemPrompt } from "./prompt-composition.ts";
import type { PromptMemorySelection, RecallLimits } from "./recall-policy.ts";
import { DEFAULT_RECALL_LIMITS, selectPromptMemory } from "./recall-policy.ts";

export interface RunPromptInput {
  readonly bot: PromptBotIdentity;
  /** The bot's own instructions; blank ones are omitted rather than emitted empty. */
  readonly instructions?: string | undefined;
  readonly sections?: readonly PromptSection[] | undefined;
  /** The bot's live documents, in the order the store lists them (oldest first). */
  readonly memory?: readonly MemoryDocument[] | undefined;
  /**
   * Content ingested for this run, in the order it should be shown. Each entry
   * becomes a `data`-channel section under its provenance line, so external
   * content reaches the model as reference data the notice tells it not to
   * obey; the caller cannot place it in the instruction channel because it
   * never builds the section itself.
   */
  readonly ingested?: readonly UntrustedContent[] | undefined;
  /**
   * Where ingested sections sit among the caller sections; defaults to 900, so
   * external content follows the deployment's instructions and precedes
   * memory. Must fall strictly between the identity and memory orders.
   */
  readonly ingestedOrder?: number | undefined;
  readonly limits?: RecallLimits | undefined;
}

export interface RunPrompt {
  /** The rendered system prompt, ready for the run's start request. */
  readonly systemPrompt: string;
  /** The composed sections, for a caller that audits rather than renders. */
  readonly prompt: ComposedPrompt;
  /** What memory was selected, and what the limits left out. */
  readonly memory: PromptMemorySelection;
}

/** After caller instructions, before memory; both ends are the composer's. */
const DEFAULT_INGESTED_ORDER = 900;

/**
 * Composes one run's system prompt with the memory lane bounded. The memory
 * records reach the composer as data, never as instructions, and a caller
 * cannot smuggle them into another channel because the composer labels the
 * memory section itself. Ingested content takes the same route: it is
 * converted here, from a labelled value into a data section, so a run prompt
 * can never carry a web page as an instruction.
 */
export function composeRunPrompt(input: RunPromptInput): RunPrompt {
  const memory = selectPromptMemory(input.memory ?? [], input.limits ?? DEFAULT_RECALL_LIMITS);
  const ingestedOrder = input.ingestedOrder ?? DEFAULT_INGESTED_ORDER;

  const ingested = (input.ingested ?? []).map((content, index) =>
    untrustedPromptSection(content, { id: `ingested.${index}`, order: ingestedOrder }),
  );

  const prompt = composeSystemPrompt({
    bot: input.bot,
    instructions: input.instructions,
    sections: [...(input.sections ?? []), ...ingested],
    memory: memory.documents,
  });

  return { systemPrompt: prompt.text, prompt, memory };
}
