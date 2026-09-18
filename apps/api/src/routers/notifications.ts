import { NOTIFICATION_KINDS } from "@porkbot/core";
import type { NotificationPreferenceSet } from "@porkbot/core";
import { authenticated } from "../gate.ts";

/**
 * The notification preferences router: the operator's own switches, read and
 * flipped. The handler receives the actor-scoped repositories, so the store it
 * writes through is bound to the session's space and user and the input never
 * names either; a caller can only reach its own switches.
 *
 * The response is the whole set in `@porkbot/core`'s vocabulary order, which is
 * what lets the store return a record and the wire answer an array without a
 * second source of truth for which kinds exist.
 */
export function createNotificationsRouter() {
  const preferences = authenticated.notifications.preferences.handler(async ({ context }) => {
    return toView(await context.repositories.notifications.read());
  });

  const setPreference = authenticated.notifications.setPreference.handler(
    async ({ input, context }) => {
      return toView(await context.repositories.notifications.set(input.kind, input.enabled));
    },
  );

  return authenticated.notifications.router({ preferences, setPreference });
}

function toView(preferences: NotificationPreferenceSet) {
  return {
    preferences: NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: preferences[kind] })),
  };
}
