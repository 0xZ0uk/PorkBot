import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createSettingsUsageController } from "./settings-usage.ts";
import type {
  SettingsUsageController,
  SettingsUsageState,
  SettingsUsageTransport,
  UsageWindow,
} from "./settings-usage.ts";
import type { BotsTransport } from "./bots.ts";
import type { UsageTransport } from "./transport.ts";

/**
 * The React binding for the usage settings surface: the controller is created
 * from the two transports the shell already holds — the bot list and the usage
 * read — loaded once on mount, and its state is read through
 * `useSyncExternalStore`. Both transports are stable for the life of the
 * route, so the controller is created once and a re-render never restarts a
 * load.
 */

export interface UseSettingsUsageOptions {
  readonly bots: BotsTransport;
  readonly usage: UsageTransport;
}

export interface UseSettingsUsageResult {
  readonly state: SettingsUsageState;
  readonly load: () => void;
  readonly setDays: (days: UsageWindow) => void;
}

export function useSettingsUsage(options: UseSettingsUsageOptions): UseSettingsUsageResult {
  const { bots, usage } = options;
  // The controller's transport is one object with two methods; it is rebuilt
  // only when either half changes, so `useMemo`'s dependency is the pair.
  const transport: SettingsUsageTransport = useMemo(
    () => ({
      listBots: () => bots.listBots("active"),
      forBot: (botId, days) => usage.forBot(botId, days),
    }),
    [bots, usage],
  );
  const controller: SettingsUsageController = useMemo(
    () => createSettingsUsageController({ transport }),
    [transport],
  );

  useEffect(() => {
    controller.load();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);

  return { state, load: controller.load, setDays: controller.setDays };
}
