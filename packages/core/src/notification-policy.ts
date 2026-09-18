/**
 * What is worth interrupting an operator for (slice 8.6, PRD decision 33;
 * stories 35).
 *
 * Story 35 wants a notification when a long run finishes or fails, and PRD
 * decision 33 adds stuck-run detection to the same path. The events that can
 * notify are a closed vocabulary — finish, failure, an approval request, a
 * stalled run — and the operator, not the adapter, decides which of them are
 * worth an interruption. The preference set is plain data keyed by that
 * vocabulary, and `shouldNotify` is the one place the decision is made, so the
 * durable store, the delivery service and the settings surface cannot drift
 * about what a preference means.
 *
 * The defaults are deliberately quiet: nothing notifies until the operator
 * says so. The reference implementation defaults every category on, which
 * interrupts for the normal case (a run finished) as loudly as for the
 * exceptional one; here the absence of a preference row is an off switch, and
 * turning one on is an explicit act. `run.completed` is the noisiest of the
 * four — every successful run reaches it — and it is the least likely default
 * anyone would choose.
 */

export const NOTIFICATION_KINDS = [
  /** A run reached a successful terminal state. */
  "run.completed",
  /** A run failed: the model, a tool, the computer or the lease. */
  "run.failed",
  /** A run is suspended on an approval an operator must answer. */
  "run.needs_approval",
  /** The watchdog found a run making no progress and reclaimed it. */
  "run.stalled",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Every kind's switch, all present, so a reader never has to infer an absent key. */
export type NotificationPreferenceSet = Readonly<Record<NotificationKind, boolean>>;

/**
 * The quiet default: no event notifies until the operator enables it. A stored
 * row overrides exactly one kind; everything else stays off.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferenceSet = Object.freeze({
  "run.completed": false,
  "run.failed": false,
  "run.needs_approval": false,
  "run.stalled": false,
});

/** One stored preference row, as the durable store reads it. */
export interface StoredNotificationPreference {
  readonly kind: NotificationKind;
  readonly enabled: boolean;
}

export function isNotificationKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/**
 * The effective preference set: the quiet defaults with the stored rows laid
 * over them. A row whose kind the running code does not know is ignored rather
 * than refused, so a row written by a newer version cannot break an older one,
 * and a kind the code knows but the store has no row for stays off.
 */
export function resolveNotificationPreferences(
  stored: readonly StoredNotificationPreference[],
): NotificationPreferenceSet {
  const resolved: Record<NotificationKind, boolean> = { ...DEFAULT_NOTIFICATION_PREFERENCES };

  for (const preference of stored) {
    if (isNotificationKind(preference.kind)) {
      resolved[preference.kind] = preference.enabled;
    }
  }

  return resolved;
}

/** Whether one event is worth interrupting for, given the operator's choices. */
export function shouldNotify(
  preferences: NotificationPreferenceSet,
  kind: NotificationKind,
): boolean {
  return preferences[kind];
}
