import { useSyncExternalStore } from "react";
import type { SessionController, SessionState } from "./session.ts";

/** The React binding for the session controller: a route renders its state. */
export function useSession(controller: SessionController): SessionState {
  return useSyncExternalStore(controller.subscribe, controller.state, controller.state);
}
