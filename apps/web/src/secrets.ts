import type { Bot, BotSecretAuthView, BotSecretView } from "@porkbot/contracts";

/**
 * The bot-secrets settings surface's state machine (slice 11.5; slice 9.6's
 * contract): one bot's stored secrets, read by name, destination and status,
 * and the operator's two writes.
 *
 * The screen never holds a value. A stored secret is a name, the one HTTPS
 * origin it may be sent to and how it authenticates; `put` takes a value in
 * its request body and the controller forgets it immediately, and nothing the
 * transport answers carries one back. Forgetting is the destructive write, so
 * the confirmation comes before it and the outcome sentence says whether a
 * value was actually cleared — a retry that found nothing says so rather than
 * implying a second deletion.
 *
 * Selecting another bot is a read of that bot's list, not a filter of the
 * previous one: the rows are per bot, and a stale row shown under the wrong
 * name would be a secret attributed to the wrong destination.
 */

/** A secret the operator is storing; the auth union mirrors the contract's. */
export interface NewSecretInput {
  readonly name: string;
  readonly value: string;
  readonly origin: string;
  readonly auth: BotSecretAuthView;
}

/** The secrets surface's API, narrow enough to fake. */
export interface SecretsTransport {
  /** The active bots, for the picker. */
  listBots(): Promise<readonly Bot[]>;
  listSecrets(botId: string): Promise<readonly BotSecretView[]>;
  store(input: {
    readonly botId: string;
    readonly name: string;
    readonly value: string;
    readonly origin: string;
    readonly auth: BotSecretAuthView;
  }): Promise<BotSecretView>;
  /** Forgets by name; the answer says whether a value was there to clear. */
  forget(input: {
    readonly botId: string;
    readonly name: string;
  }): Promise<{ readonly removed: boolean }>;
}

export interface SecretsNotice {
  readonly kind: "info" | "error";
  readonly text: string;
}

export interface SecretsState {
  readonly status: "loading" | "ready" | "refused";
  /** The sentence to show when `status` is `refused`, else `null`. */
  readonly refusal: string | null;
  readonly bots: readonly Bot[];
  /** The bot whose rows are shown; `null` while loading or with no bots. */
  readonly selectedBotId: string | null;
  readonly secrets: readonly BotSecretView[];
  readonly notice: SecretsNotice | null;
  /** The bot id or secret name whose read or write is in flight. */
  readonly pending: string | null;
}

export interface SecretsController {
  state(): SecretsState;
  subscribe(listener: () => void): () => void;
  /** The initial read and the explicit retry; clears any notice. */
  load(): void;
  selectBot(botId: string): Promise<void>;
  /** Stores the value and re-reads; `true` when the row is on screen after. */
  store(input: NewSecretInput): Promise<boolean>;
  forget(name: string): Promise<void>;
}

export interface SecretsControllerOptions {
  readonly transport: SecretsTransport;
}

const unreadable = "Secrets could not be loaded.";

/** The confirmation sentence for a forget, shown before the write. */
export function forgetWarning(name: string): string {
  return `Forgetting ${name} clears the stored value now; a request that uses it fails until it is stored again.`;
}

/**
 * The confirmation sentence for a store that replaces an existing value: the
 * rotate. The old value is gone the moment the new one is stored, so the
 * consequence is named before the write exactly like a forget's.
 */
export function rotateWarning(name: string): string {
  return `A secret named ${name} is already stored. Storing now replaces its value; a request that used the old value fails until the new one is accepted.`;
}

/** The outcome sentence for a forget, shown after the write. */
export function forgetOutcome(name: string, removed: boolean): string {
  return removed
    ? `Forgot ${name}. The stored value was cleared.`
    : `Forgot ${name}. No value was stored.`;
}

/** How a stored secret authenticates, in words. */
export function authLabel(auth: BotSecretAuthView): string {
  switch (auth.type) {
    case "bearer":
      return "Bearer token";
    case "header":
      return `Header ${auth.name}`;
    case "basic":
      return `Basic ${auth.username}`;
  }
}

/** The status as words; `forgotten` is a row that holds no value, not an error. */
export function secretStatusLabel(status: BotSecretView["status"]): string {
  return status === "stored" ? "Stored" : "No value";
}

export function createSecretsController(options: SecretsControllerOptions): SecretsController {
  const { transport } = options;
  const listeners = new Set<() => void>();
  let state: SecretsState = {
    status: "loading",
    refusal: null,
    bots: [],
    selectedBotId: null,
    secrets: [],
    notice: null,
    pending: null,
  };
  // Bumped on every bot read, so a late answer for a bot the operator already
  // switched away from cannot land under the new selection.
  let generation = 0;

  function publish(next: SecretsState): void {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  async function readSecrets(botId: string, showLoading: boolean): Promise<void> {
    const mine = ++generation;
    publish({
      ...state,
      status: showLoading ? "loading" : state.status,
      pending: botId,
    });

    try {
      const secrets = await transport.listSecrets(botId);

      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "ready", selectedBotId: botId, secrets, pending: null });
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "refused", refusal: unreadable, pending: null });
    }
  }

  async function reload(): Promise<void> {
    const mine = ++generation;
    publish({ ...state, status: "loading", refusal: null, notice: null });

    let bots: readonly Bot[];

    try {
      bots = await transport.listBots();
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "refused", refusal: unreadable });

      return;
    }

    if (mine !== generation) {
      return;
    }

    const selected = bots.find((bot) => bot.id === state.selectedBotId) ?? bots[0];

    if (selected === undefined) {
      publish({ ...state, status: "ready", bots, selectedBotId: null, secrets: [], refusal: null });

      return;
    }

    publish({ ...state, bots, selectedBotId: selected.id });

    try {
      const secrets = await transport.listSecrets(selected.id);

      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "ready", secrets, refusal: null });
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "refused", refusal: unreadable });
    }
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    load() {
      void reload();
    },

    async selectBot(botId) {
      if (botId === state.selectedBotId) {
        return;
      }

      // The previous bot's refusal must not hide the picker: the new read
      // starts from a clean, ready frame with the rows cleared, so a failure
      // is answered under the bot the operator actually chose.
      publish({ ...state, status: "ready", refusal: null, notice: null, secrets: [] });
      await readSecrets(botId, false);
    },

    async store(input) {
      const botId = state.selectedBotId;

      if (botId === null) {
        return false;
      }

      publish({ ...state, pending: "store", notice: null });

      try {
        await transport.store({ botId, ...input });
      } catch {
        publish({
          ...state,
          pending: null,
          notice: { kind: "error", text: "The secret could not be stored." },
        });

        return false;
      }

      publish({
        ...state,
        pending: null,
        notice: { kind: "info", text: `Stored ${input.name}.` },
      });
      await readSecrets(botId, false);

      return true;
    },

    async forget(name) {
      const botId = state.selectedBotId;

      if (botId === null) {
        return;
      }

      publish({ ...state, pending: name, notice: null });

      try {
        const result = await transport.forget({ botId, name });

        publish({
          ...state,
          pending: null,
          notice: { kind: "info", text: forgetOutcome(name, result.removed) },
        });
      } catch {
        publish({
          ...state,
          pending: null,
          notice: { kind: "error", text: "The secret could not be forgotten." },
        });

        return;
      }

      await readSecrets(botId, false);
    },
  };
}
