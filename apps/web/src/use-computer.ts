import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createComputerController } from "./computer.ts";
import type { ComputerController, ComputerState, ComputerTransport } from "./computer.ts";

/**
 * The React binding for the computer settings screen: the controller is
 * created from the transport and the bot id, loaded once on mount, and its
 * state is read through `useSyncExternalStore`. The transport is stable for
 * the life of the route, so a re-render never restarts a load.
 */

export interface UseComputerOptions {
  readonly transport: ComputerTransport;
  readonly botId: string;
}

export interface UseComputerResult {
  readonly state: ComputerState;
  readonly load: () => void;
  readonly choose: ComputerController["choose"];
  readonly cancel: ComputerController["cancel"];
  readonly confirm: ComputerController["confirm"];
  readonly snapshot: ComputerController["snapshot"];
  readonly restore: ComputerController["restore"];
  readonly lifecycle: ComputerController["lifecycle"];
  readonly run: ComputerController["run"];
  readonly openDirectory: ComputerController["openDirectory"];
  readonly openFile: ComputerController["openFile"];
  readonly openParent: ComputerController["openParent"];
}

export function useComputer(options: UseComputerOptions): UseComputerResult {
  const { transport, botId } = options;
  const controller = useMemo(
    () => createComputerController({ transport, botId }),
    [transport, botId],
  );

  useEffect(() => {
    controller.load();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);

  return {
    state,
    load: controller.load,
    choose: controller.choose,
    cancel: controller.cancel,
    confirm: controller.confirm,
    snapshot: controller.snapshot,
    restore: controller.restore,
    lifecycle: controller.lifecycle,
    run: controller.run,
    openDirectory: controller.openDirectory,
    openFile: controller.openFile,
    openParent: controller.openParent,
  };
}
