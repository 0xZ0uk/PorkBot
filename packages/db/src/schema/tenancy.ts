import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";
import { user } from "./identity.ts";

/**
 * Tenancy and deployment configuration.
 *
 * `space_member` is the authorization root: an Actor is a session plus one of
 * these rows (PRD decision 7), so `(space_id, user_id)` is unique at the
 * database and both columns are NOT NULL — a NULL in either would make the
 * dedupe vacuous and hand a user a second membership in the same space.
 * `role` is a closed set, so it is a Postgres enum and the server rejects an
 * unknown role even if application code is wrong (PRD decision 6). Extensible
 * sets are not enums; this schema has no lookup table yet.
 *
 * A space has exactly one owner: the partial unique index lets many members
 * share a space while the owner slot admits one row, so slice 3.4's bootstrap
 * cannot lose that race even if its own check is wrong. v1.0 has no role
 * management UI and no invite flow; this index is what makes "one operator"
 * a database answer rather than a promise.
 *
 * `deployment_settings` is the fail-closed half of ownership (PRD decision 8):
 * it is the deployment's configuration row, and `signups_enabled` has no
 * default, so a row can only exist because someone wrote the value down. The
 * check makes the other half structural as well: signups cannot be open while
 * no admin email is configured, because an open deployment with no named owner
 * is the first-registrant inheritance the PRD outlaws.
 */

export const spaceMemberRole = pgEnum("space_member_role", ["owner", "member"]);

export const space = pgTable("space", {
  id: primaryKeyId(),
  name: text("name").notNull(),
  ...timestamps(),
});

export const spaceMember = pgTable(
  "space_member",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: spaceMemberRole("role").notNull().default("member"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("space_member_space_user_unique").on(table.spaceId, table.userId),
    uniqueIndex("space_member_owner_unique")
      .on(table.spaceId)
      .where(sql`${table.role} = 'owner'`),
    index("space_member_user_id_idx").on(table.userId),
  ],
);

export const deploymentSettings = pgTable(
  "deployment_settings",
  {
    id: primaryKeyId(),
    signupsEnabled: boolean("signups_enabled").notNull(),
    adminEmail: text("admin_email"),
    ...timestamps(),
  },
  (table) => [
    check(
      "deployment_settings_signups_require_admin",
      sql`not ${table.signupsEnabled} or ${table.adminEmail} is not null`,
    ),
  ],
);
