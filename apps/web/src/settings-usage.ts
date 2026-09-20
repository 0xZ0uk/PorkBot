import type { Bot, UsageBot } from "@porkbot/contracts";

/**
 * The usage settings surface's state machine (slice 11.5, story 34): every
 * active bot's recorded totals over one chosen window.
 *
 * The read is per bot because the contract's is; the controller fans out over
 * the bot list and keeps each answer with its bot, so the screen never has to
 * join two lists by id. The window choice re-reads rather than filtering
 * locally: the daily buckets the server returns are the contract's, and the
 * all-time total is window-independent by design. A bot whose read fails
 * refuses the whole screen — a usage table missing a row would read as a bot
 * that spent nothing, which is the one lie this surface must not tell.
 */

/** The windows the surface offers, in days; the contract bounds the value. */
export const usageWindows = [7, 30, 90] as const;

export type UsageWindow = (typeof usageWindows)[number];

/** One bot's report, paired with the bot it belongs to. */
export interface BotUsage {
  readonly bot: Bot;
  readonly usage: UsageBot;
}

/** The usage surface's API, narrow enough to fake. */
export interface SettingsUsageTransport {
  listBots(): Promise<readonly Bot[]>;
  forBot(botId: string, days: number): Promise<UsageBot>;
}

export interface SettingsUsageState {
  readonly status: "loading" | "ready" | "refused";
  /** The sentence to show when `status` is `refused`, else `null`. */
  readonly refusal: string | null;
  readonly days: UsageWindow;
  readonly reports: readonly BotUsage[];
  /** True while a window change is reading; the table stays visible. */
  readonly reloading: boolean;
}

export interface SettingsUsageController {
  state(): SettingsUsageState;
  subscribe(listener: () => void): () => void;
  /** The initial read and the explicit retry. */
  load(): void;
  setDays(days: UsageWindow): void;
}

export interface SettingsUsageControllerOptions {
  readonly transport: SettingsUsageTransport;
  /** The initial window; defaults to the contract's own 30 days. */
  readonly days?: UsageWindow;
}

const unreadable = "Usage could not be loaded.";

export function createSettingsUsageController(
  options: SettingsUsageControllerOptions,
): SettingsUsageController {
  const { transport } = options;
  const listeners = new Set<() => void>();
  let state: SettingsUsageState = {
    status: "loading",
    refusal: null,
    days: options.days ?? 30,
    reports: [],
    reloading: false,
  };
  // Bumped on every read, so a late answer from a superseded window cannot
  // replace the state the newer window already produced.
  let generation = 0;

  function publish(next: SettingsUsageState): void {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  async function reload(days: UsageWindow): Promise<void> {
    const mine = ++generation;
    const first = state.reports.length === 0;

    publish({ ...state, status: first ? "loading" : "ready", refusal: null, reloading: !first });

    try {
      const bots = await transport.listBots();
      const reports = await Promise.all(
        bots.map(async (bot) => ({ bot, usage: await transport.forBot(bot.id, days) })),
      );

      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "ready", days, reports, refusal: null, reloading: false });
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "refused", refusal: unreadable, reloading: false });
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
      void reload(state.days);
    },

    setDays(days) {
      if (days === state.days) {
        return;
      }

      void reload(days);
    },
  };
}
