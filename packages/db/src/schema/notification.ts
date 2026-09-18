import { boolean, index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";
import { notificationKind } from "./enums.ts";
import { user } from "./identity.ts";
import { space } from "./tenancy.ts";

/**
 * Per-operator notification preferences (slice 8.6, PRD decision 33; story 35).
 *
 * The row is an opt-in: no row for a `(space, user, kind)` means the quiet
 * default, which is off. A row stores the operator's choice for one kind, so
 * adding an event kind never needs a backfill, and `(space_id, user_id, kind)`
 * is unique because there is exactly one switch per operator per event — the
 * upsert in the store is what keeps a second write from growing a second row.
 *
 * The store is scoped by actor, never by a space or user argument: an operator
 * reads and writes their own switches, and the delivery path reads one
 * recipient's switch through a join against `space_member`, so a row that
 * outlives a membership cannot notify a non-member. The user foreign key
 * cascades with the user's deletion and the space foreign key with the space's,
 * so those deletions leave no preference behind; a removed membership does not
 * delete the row — the delivery path's join is what suppresses it.
 */
export const notificationPreference = pgTable(
  "notification_preference",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: notificationKind("kind").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("notification_preference_space_user_kind_unique").on(
      table.spaceId,
      table.userId,
      table.kind,
    ),
    index("notification_preference_user_idx").on(table.userId),
  ],
);
