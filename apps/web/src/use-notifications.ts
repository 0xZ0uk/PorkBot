import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createNotificationsController } from "./notifications.ts";
import type {
  NotificationsController,
  NotificationsState,
  NotificationsTransport,
} from "./notifications.ts";
import type { NotificationKind } from "@porkbot/core";

/**
 * The React binding for the notification switches: the controller is created
 * from the transport, loaded once on mount, and its state is read through
 * `useSyncExternalStore`. The transport is stable for the life of the route,
 * so the controller is created once and a re-render never restarts a load.
 */

export interface UseNotificationsOptions {
  readonly transport: NotificationsTransport;
}

export interface UseNotificationsResult {
  readonly state: NotificationsState;
  readonly load: () => void;
  readonly setPreference: (kind: NotificationKind, enabled: boolean) => Promise<void>;
}

export function useNotifications(options: UseNotificationsOptions): UseNotificationsResult {
  const { transport } = options;
  const controller: NotificationsController = useMemo(
    () => createNotificationsController({ transport }),
    [transport],
  );

  useEffect(() => {
    controller.load();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);

  return { state, load: controller.load, setPreference: controller.setPreference };
}
