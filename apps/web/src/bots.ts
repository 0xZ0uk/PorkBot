import type { AvatarContentType, Bot, BotSection, ComputerView, Thread } from "@porkbot/contracts";

/** The complete API surface used by the bot home and editor. */
export interface BotsTransport {
  listBots(scope: "active" | "archived"): Promise<readonly Bot[]>;
  getBot(id: string): Promise<Bot>;
  listSections(): Promise<readonly BotSection[]>;
  listThreads(botId: string): Promise<readonly Thread[]>;
  computerStatus(botId: string): Promise<ComputerView>;
  createBot(input: BotWriteInput & { readonly spawnKey: string }): Promise<Bot>;
  updateBot(id: string, input: BotWriteInput): Promise<Bot>;
  archiveBot(id: string): Promise<Bot>;
  restoreBot(id: string): Promise<Bot>;
  /** Pins a bot to the roster's top group, or returns it to its section. */
  setPinned(id: string, pinned: boolean): Promise<Bot>;
  createSection(name: string): Promise<BotSection>;
  readAvatar(id: string): Promise<{ readonly contentType: string; readonly data: string }>;
  setAvatar(input: {
    readonly id: string;
    readonly contentType: AvatarContentType;
    readonly data: string;
  }): Promise<Bot>;
  clearAvatar(id: string): Promise<Bot>;
  bootComputer(botId: string): Promise<ComputerView>;
  stopComputer(botId: string): Promise<ComputerView>;
  recoverComputer(botId: string): Promise<ComputerView>;
}

/** Fields shared by create and edit. Empty optional strings are intentional values. */
export interface BotWriteInput {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly color: string;
  readonly sectionId: string | null;
  readonly computerProvider: string | null;
}

export type ComputerHealth =
  | { readonly kind: "healthy"; readonly view: ComputerView }
  | { readonly kind: "stopped"; readonly view: ComputerView }
  | { readonly kind: "failed" };

export interface BotFormValues {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly color: string;
  readonly sectionId: string;
  readonly computerProvider: string;
}

export type BotFormErrors = Partial<Record<keyof BotFormValues, string>>;

/** Actionable client-side messages for constraints the contract will enforce. */
export function validateBotForm(values: BotFormValues): BotFormErrors {
  const errors: BotFormErrors = {};

  if (values.name.trim().length === 0) {
    errors.name = "Enter a name for this bot.";
  } else if (values.name.length > 200) {
    errors.name = "Keep the name to 200 characters or fewer.";
  }

  if (values.title.length > 200) {
    errors.title = "Keep the title to 200 characters or fewer.";
  }

  if (values.description.length > 4_000) {
    errors.description = "Keep the description to 4,000 characters or fewer.";
  }

  if (values.instructions.length > 100_000) {
    errors.instructions = "Keep the instructions to 100,000 characters or fewer.";
  }

  if (values.color.trim().length === 0) {
    errors.color = "Choose a colour for this bot.";
  }

  if (values.computerProvider.length > 64) {
    errors.computerProvider = "Keep the computer provider to 64 characters or fewer.";
  }

  return errors;
}

export function formToWriteInput(values: BotFormValues): BotWriteInput {
  return {
    name: values.name.trim(),
    title: values.title.trim(),
    description: values.description.trim(),
    instructions: values.instructions,
    color: values.color,
    sectionId: values.sectionId === "" ? null : values.sectionId,
    computerProvider: values.computerProvider.trim() === "" ? null : values.computerProvider.trim(),
  };
}

export function formFromBot(bot: Bot): BotFormValues {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    color: bot.color,
    sectionId: bot.sectionId ?? "",
    computerProvider: bot.computerProvider ?? "",
  };
}

/** A failed status read is a visible bot state, not a reason to lose the list. */
export async function readComputerHealth(
  transport: Pick<BotsTransport, "computerStatus">,
  botId: string,
): Promise<ComputerHealth> {
  try {
    const view = await transport.computerStatus(botId);

    if (view.assigned && view.state !== "running") {
      return { kind: "stopped", view };
    }

    return { kind: "healthy", view };
  } catch {
    return { kind: "failed" };
  }
}

export function latestActivity(threads: readonly Thread[]): string | null {
  return threads[0]?.updatedAt ?? null;
}
