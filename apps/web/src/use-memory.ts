import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createMemoryController } from "./memory.ts";
import type { MemoryController, MemoryScope, MemoryState, MemoryTransport } from "./memory.ts";

/**
 * The React binding for one bot's memory: the controller is created from the
 * transport and the route's bot id, loaded once on mount, and its state is read
 * through `useSyncExternalStore`. Both options are stable for the life of a
 * route, so the controller is created once and a re-render never restarts a
 * load.
 */

export interface UseMemoryOptions {
  readonly transport: MemoryTransport;
  readonly botId: string;
}

export interface UseMemoryResult {
  readonly state: MemoryState;
  readonly load: () => void;
  readonly setScope: (scope: MemoryScope) => void;
  readonly toggleHistory: (documentId: string) => void;
  readonly save: MemoryController["save"];
  readonly remove: MemoryController["remove"];
  readonly restore: MemoryController["restore"];
}

export function useMemory(options: UseMemoryOptions): UseMemoryResult {
  const { transport, botId } = options;
  const controller = useMemo(
    () => createMemoryController({ transport, botId }),
    [transport, botId],
  );

  useEffect(() => {
    controller.load();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);
  const load = useCallback(() => {
    controller.load();
  }, [controller]);
  const setScope = useCallback(
    (scope: MemoryScope) => {
      controller.setScope(scope);
    },
    [controller],
  );
  const toggleHistory = useCallback(
    (documentId: string) => {
      controller.toggleHistory(documentId);
    },
    [controller],
  );

  return {
    state,
    load,
    setScope,
    toggleHistory,
    save: controller.save,
    remove: controller.remove,
    restore: controller.restore,
  };
}
