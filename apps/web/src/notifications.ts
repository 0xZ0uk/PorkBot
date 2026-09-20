import type { NotificationPreference } from "@porkbot/contracts";
import type { NotificationKind } from "@porkbot/core";

/**
 * The notification settings surface's state machine (slice 11.5, story 35).
 * A framework-free controller like the connections screen's: the screen
 * renders one state object and the read/write rules live where a unit test can
 * drive them without a DOM.
 *
 * Every write answers the whole set, so the controller stores exactly what the
 * server answered and never merges a partial response into what it showed. A
 * write in flight holds only its own switch; the others stay usable, and a
 * failed write leaves the last server answer on screen with a notice instead
 * of a switch that lies about a state nobody stored.
 */

/** The notification API the screen needs, narrow enough to fake. */
export interface NotificationsTransport {
  preferences(): Promise<readonly NotificationPreference[]>;
  setPreference(input: {
    readonly kind: NotificationKind;
    readonly enabled: boolean;
  }): Promise<readonly NotificationPreference[]>;
}

export interface NotificationsState {
  readonly status: "loading" | "ready" | "refused";
  /** The sentence to show when `status` is `refused`, else `null`. */
  readonly refusal: string | null;
  readonly preferences: readonly NotificationPreference[];
  /** The kind whose write is in flight, for disabling exactly that switch. */
  readonly pending: NotificationKind | null;
  readonly notice: string | null;
}

export interface NotificationsController {
  state(): NotificationsState;
  subscribe(listener: () => void): () => void;
  /** The initial read and the explicit retry; clears any notice. */
  load(): void;
  setPreference(kind: NotificationKind, enabled: boolean): Promise<void>;
}

export interface NotificationsControllerOptions {
  readonly transport: NotificationsTransport;
}

const unreadable = "Notification settings could not be loaded.";

/**
 * The one place a kind becomes words. The labels are the settings surface's
 * own copy; the vocabulary stays `@porkbot/core`'s, so a new kind fails the
 * exhaustive map rather than rendering as a raw identifier.
 */
const labels: Readonly<Record<NotificationKind, string>> = {
  "run.completed": "Run finished",
  "run.failed": "Run failed",
  "run.needs_approval": "Approval needed",
  "run.stalled": "Run stalled",
};

export function notificationLabel(kind: NotificationKind): string {
  return labels[kind];
}

export function createNotificationsController(
  options: NotificationsControllerOptions,
): NotificationsController {
  const { transport } = options;
  const listeners = new Set<() => void>();
  let state: NotificationsState = {
    status: "loading",
    refusal: null,
    preferences: [],
    pending: null,
    notice: null,
  };
  // Bumped on every read, so a late answer from a superseded load cannot
  // replace the state a newer one already produced.
  let generation = 0;

  function publish(next: NotificationsState): void {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  async function reload(clearNotice: boolean): Promise<void> {
    const mine = ++generation;
    publish({
      ...state,
      status: "loading",
      refusal: null,
      ...(clearNotice ? { notice: null } : {}),
    });

    try {
      const preferences = await transport.preferences();

      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "ready", preferences, refusal: null });
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "refused", refusal: unreadable });
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
      void reload(true);
    },

    async setPreference(kind, enabled) {
      publish({ ...state, pending: kind, notice: null });

      try {
        const preferences = await transport.setPreference({ kind, enabled });

        publish({ ...state, pending: null, preferences });
      } catch {
        // The set on screen stays the last one the server answered; the notice
        // says the write did not land rather than flipping the switch anyway.
        publish({
          ...state,
          pending: null,
          notice: "The change could not be saved.",
        });
      }
    },
  };
}
