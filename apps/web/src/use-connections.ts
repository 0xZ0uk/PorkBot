import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createConnectionsController } from "./connections.ts";
import type {
  ConnectionsController,
  ConnectionsState,
  ConnectionsTransport,
  NewConnectionInput,
} from "./connections.ts";

/**
 * The React binding for the connections screen: the controller is created from
 * the transport, loaded once on mount, and its state is read through
 * `useSyncExternalStore`. The transport is stable for the life of the route,
 * so the controller is created once and a re-render never restarts a load.
 */

export interface UseConnectionsOptions {
  readonly transport: ConnectionsTransport;
}

export interface UseConnectionsResult {
  readonly state: ConnectionsState;
  readonly load: () => void;
  readonly probe: ConnectionsController["probe"];
  readonly setDefault: ConnectionsController["setDefault"];
  readonly disconnect: ConnectionsController["disconnect"];
  readonly revoke: ConnectionsController["revoke"];
  readonly create: (input: NewConnectionInput) => Promise<boolean>;
  readonly setBotConnection: ConnectionsController["setBotConnection"];
}

export function useConnections(options: UseConnectionsOptions): UseConnectionsResult {
  const { transport } = options;
  const controller = useMemo(() => createConnectionsController({ transport }), [transport]);

  useEffect(() => {
    controller.load();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);

  return {
    state,
    load: controller.load,
    probe: controller.probe,
    setDefault: controller.setDefault,
    disconnect: controller.disconnect,
    revoke: controller.revoke,
    create: controller.create,
    setBotConnection: controller.setBotConnection,
  };
}
