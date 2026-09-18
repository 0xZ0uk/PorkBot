import type { NotificationKind, NotificationPreferenceSet } from "@porkbot/core";

/**
 * The durable half of notification preferences (slice 8.6, PRD decision 33;
 * stories 35).
 *
 * The event vocabulary and the quiet defaults live in `@porkbot/core`; this
 * seam is how the delivery path and the settings surface reach the stored
 * choices. `@porkbot/db` implements it in one module over the durable
 * preference rows, and the factory splits by actor exactly as the memory store
 * and the approval gate do:
 *
 *   - A `UserActor` receives `NotificationPreferences`: the operator reads all
 *     kinds with the defaults filled in and sets one kind at a time. Every
 *     statement binds the actor's `space_id` and `user_id`, so a preference is
 *     only ever the actor's own.
 *   - A `SystemActor` receives `NotificationRecipients`: the delivery path asks
 *     whether one user has enabled one kind. The read joins the space
 *     membership, so a user who is not a member of the job's space is
 *     `not_a_recipient` — the same shape an unknown preference has — and a
 *     notification can never cross a space boundary.
 *
 * Neither half names a table; the call-site suite in `@porkbot/db` fails when
 * one does anywhere else.
 */

/** The operator's half: read and set the choices for the actor's own user. */
export interface NotificationPreferences {
  /** Every kind's switch, with the quiet defaults filled in. */
  read(): Promise<NotificationPreferenceSet>;
  /** Enables or disables one kind and returns the full set. */
  set(kind: NotificationKind, enabled: boolean): Promise<NotificationPreferenceSet>;
}

/**
 * Why a recipient should not be notified for one kind. `not_a_recipient` is
 * deliberately distinct from `disabled`: the first says the user does not
 * belong to the space, the second says they chose quiet for that event.
 */
export type NotificationEligibility = "enabled" | "disabled" | "not_a_recipient";

/** The delivery path's half: one user, one kind, and the space check built in. */
export interface NotificationRecipients {
  /**
   * The recipient's eligibility, scoped to the actor's space. A user outside
   * the space and a user whose preference is off are different answers, but
   * neither is an error and neither confirms what a foreign user chose.
   */
  eligibility(userId: string, kind: NotificationKind): Promise<NotificationEligibility>;
}
