import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";

/**
 * The Better Auth core tables (slice 3.1 wires the library to these), kept in
 * the shape Better Auth's drizzle adapter reads: `user`, `session`, `account`
 * and `verification`, camelCase field keys over snake_case columns, and ids
 * left to Postgres' `uuidv7()` default (`advanced.database.generateId: false`).
 *
 * The constraints are the point of the slice:
 *
 *   - `user.email`, `session.token` and `account (provider_id, account_id)` are
 *     unique, and every one of those columns is NOT NULL. A nullable column in
 *     a unique index makes the constraint vacuous — Postgres treats each NULL
 *     as distinct — so the dedupe rule is only as real as the NOT NULL beside
 *     it (PRD decision 5).
 *   - `provider_id` is text, not an enum: provider kinds are an extensible set,
 *     and the schema adds a provider without a migration (PRD decision 16).
 *   - session and credential material — the session token, access, refresh and
 *     ID tokens, the password hash and verification values — is typed text and
 *     never selected into a list response or logged. Redaction is enforced at
 *     the logging boundary; keeping the shape narrow here is what makes that
 *     possible.
 */

export const user = pgTable(
  "user",
  {
    id: primaryKeyId(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    ...timestamps(),
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)],
);

export const session = pgTable(
  "session",
  {
    id: primaryKeyId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("session_token_unique").on(table.token),
    index("session_user_id_idx").on(table.userId),
  ],
);

export const account = pgTable(
  "account",
  {
    id: primaryKeyId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
    index("account_user_id_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: primaryKeyId(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("verification_identifier_value_unique").on(table.identifier, table.value),
  ],
);
