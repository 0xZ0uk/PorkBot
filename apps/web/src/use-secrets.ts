import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createSecretsController } from "./secrets.ts";
import type {
  NewSecretInput,
  SecretsController,
  SecretsState,
  SecretsTransport,
} from "./secrets.ts";

/**
 * The React binding for the bot-secrets surface: the controller is created
 * from the transport, loaded once on mount, and its state is read through
 * `useSyncExternalStore`. The transport is stable for the life of the route,
 * so the controller is created once and a re-render never restarts a read.
 */

export interface UseSecretsOptions {
  readonly transport: SecretsTransport;
}

export interface UseSecretsResult {
  readonly state: SecretsState;
  readonly load: () => void;
  readonly selectBot: (botId: string) => Promise<void>;
  readonly store: (input: NewSecretInput) => Promise<boolean>;
  readonly forget: (name: string) => Promise<void>;
}

export function useSecrets(options: UseSecretsOptions): UseSecretsResult {
  const { transport } = options;
  const controller: SecretsController = useMemo(
    () => createSecretsController({ transport }),
    [transport],
  );

  useEffect(() => {
    controller.load();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);

  return {
    state,
    load: controller.load,
    selectBot: controller.selectBot,
    store: controller.store,
    forget: controller.forget,
  };
}
