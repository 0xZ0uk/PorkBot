import type {
  NotificationKind,
  NotificationPreferenceSet,
  StoredNotificationPreference,
} from "@porkbot/core";
import { resolveNotificationPreferences } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import type {
  NotificationEligibility,
  NotificationPreferences,
  NotificationRecipients,
} from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The durable half of notification preferences (slice 8.6, PRD decision 33;
 * stories 35), over the `notification_preference` table.
 *
 * This is the one module that names the notification rows. Every other package
 * reaches them through the `NotificationPreferences`/`NotificationRecipients`
 * seams in `@porkbot/effect`, and `notification-store.call-sites.test.ts` walks
 * the shipped source and fails when a table name appears anywhere else, so
 * "one module owns the switches" is checked rather than promised.
 *
 * The factory splits by actor as the memory store and the approval store do. A
 * `UserActor` gets the operator's half: reads return every kind with
 * `@porkbot/core`'s quiet defaults filled in, and a set writes exactly one
 * switch. Both bind the actor's `space_id` and `user_id`, so a preference is
 * only ever the actor's own. A `SystemActor` gets the delivery path's half: one
 * `eligibility(userId, kind)` answer, whose statement joins `space_member` so a
 * user outside the job's space is `not_a_recipient` — an answer that is the
 * same shape as a missing row and cannot confirm what a foreign user chose.
 *
 * Every write is an upsert on the `(space_id, user_id, kind)` unique index and
 * is scoped through the membership row, so an actor without a membership writes
 * nothing; that no-row outcome is the shared typed `NotFoundError` rather than a
 * quiet success, because a switch the caller believes it flipped and the store
 * did not is worse than a refusal.
 */

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createNotificationStore(
  actor: UserActor,
  database: Queryable,
): NotificationPreferences;
export function createNotificationStore(
  actor: SystemActor,
  database: Queryable,
): NotificationRecipients;
export function createNotificationStore(
  actor: Actor,
  database: Queryable,
): NotificationPreferences | NotificationRecipients;
export function createNotificationStore(
  actor: Actor,
  database: Queryable,
): NotificationPreferences | NotificationRecipients {
  if (actor.kind === "system") {
    return {
      async eligibility(userId: string, kind: NotificationKind): Promise<NotificationEligibility> {
        // A recipient id that is not a UUID cannot name a member, so it is the
        // same answer as an unknown user rather than a Postgres cast error.
        if (!uuidPattern.test(userId)) {
          return "not_a_recipient";
        }

        const { rows } = await database.query<{ readonly enabled: boolean }>(
          "select coalesce(p.enabled, false) as enabled " +
            "from space_member m left join notification_preference p " +
            "on p.space_id = m.space_id and p.user_id = m.user_id " +
            "and p.kind = $3::notification_kind " +
            "where m.space_id = $1 and m.user_id = $2",
          [actor.spaceId, userId, kind],
        );

        const row = rows[0];

        // No row means the user holds no membership in the actor's space. A
        // member with no preference row comes back as `enabled = false`, which
        // is the quiet default rather than an access answer.
        if (row === undefined) {
          return "not_a_recipient";
        }

        return row.enabled ? "enabled" : "disabled";
      },
    };
  }

  const read = async (): Promise<NotificationPreferenceSet> => {
    const { rows } = await database.query<StoredNotificationPreference>(
      "select kind::text as kind, enabled from notification_preference " +
        "where space_id = $1 and user_id = $2 order by kind asc",
      [actor.spaceId, actor.userId],
    );

    return resolveNotificationPreferences(rows);
  };

  return {
    read,

    async set(kind: NotificationKind, enabled: boolean): Promise<NotificationPreferenceSet> {
      // The upsert is scoped through the membership row: a user outside the
      // actor's space (or a user with no membership at all) inserts nothing,
      // so a foreign preference cannot be written even by a guessed id. A
      // membership that matches no row is a typed refusal rather than a
      // success that wrote nothing — the caller must not believe a switch
      // flipped when it did not.
      const { rows } = await database.query<{ readonly id: string }>(
        "insert into notification_preference (space_id, user_id, kind, enabled) " +
          "select $1, $2, $3::notification_kind, $4 from space_member m " +
          "where m.space_id = $1 and m.user_id = $2 " +
          "on conflict (space_id, user_id, kind) " +
          "do update set enabled = excluded.enabled, updated_at = now() " +
          "returning id",
        [actor.spaceId, actor.userId, kind, enabled],
      );

      if (rows[0] === undefined) {
        throw new NotFoundError("space membership", actor.userId);
      }

      return await read();
    },
  };
}
