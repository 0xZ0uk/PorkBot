import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Message } from "@porkbot/contracts";
import { createThreadConsole } from "./console.ts";
import { forwardRunEvent } from "./desktop.ts";
import type { ThreadConsoleState, ThreadConsoleTransport } from "./console.ts";

/**
 * The React binding for one thread's console: the console is created from the
 * transport and the route's thread id, started when the screen mounts, stopped
 * when it unmounts, and its state is read through `useSyncExternalStore` so a
 * frame re-renders exactly the components that read it.
 *
 * The options are deliberately just the transport and the id: both are stable
 * for the life of a route, so the console is created once. The controller's
 * reconnect seams stay on the controller for tests, where they cannot change
 * identity under a render and restart the subscription.
 */

export interface UseThreadConsoleOptions {
  readonly transport: ThreadConsoleTransport;
  readonly threadId: string;
}

export interface UseThreadConsoleResult {
  readonly state: ThreadConsoleState;
  readonly retry: () => void;
  /** Folds a just-sent message into the view, for the composer's send. */
  readonly noteSent: (message: Message) => void;
}

export function useThreadConsole(options: UseThreadConsoleOptions): UseThreadConsoleResult {
  const { transport, threadId } = options;
  const console = useMemo(
    // The desktop bridge is a no-op in a browser; in the Electron shell it is
    // how a settled run reaches the tray and the native notification.
    () => createThreadConsole({ transport, threadId, onRunEvent: forwardRunEvent }),
    [transport, threadId],
  );

  useEffect(() => {
    console.start();

    return () => {
      console.stop();
    };
  }, [console]);

  const state = useSyncExternalStore(console.subscribe, console.state, console.state);
  const retry = useCallback(() => {
    console.retry();
  }, [console]);
  const noteSent = useCallback(
    (message: Message) => {
      console.noteSent(message);
    },
    [console],
  );

  return { state, retry, noteSent };
}
