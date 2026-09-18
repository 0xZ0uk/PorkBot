import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryKeyId, timestamps } from "./columns.ts";
import { space } from "./tenancy.ts";
import { user } from "./identity.ts";

/**
 * The two ingress ledgers (slice 4.5, PRD decision 24).
 *
 * Ingress is the deployment's only unauthenticated write surface, so both
 * dedupe rules are database constraints rather than application bookkeeping —
 * the same shape the runs domain uses for its idempotency keys:
 *
 *   - `webhook_delivery` remembers a provider's delivery id so a redelivery is
 *     a no-op. The unique index covers `(source, delivery_id)` and both
 *     columns are NOT NULL, so a NULL cannot make the constraint vacuous (PRD
 *     decision 5). `expires_at` is written by the recorder and swept on the
 *     next delivery, so the table is bounded by the dedupe window instead of
 *     growing forever; the index on it makes the sweep a range delete.
 *   - `oauth_state` holds the one-time binding of an OAuth `state` to the
 *     actor and space that started the flow. The table stores only the state's
 *     SHA-256, never the bearer value, so a database read cannot replay a
 *     callback. Consumption is an atomic `update ... where consumed_at is null
 *     and expires_at > now()`: the first callback wins and every replay matches
 *     no row. Both foreign keys are NOT NULL and indexed, so deleting an actor
 *     or a space cannot leave a state that resolves to nothing.
 *
 * `provider_id`-style extensibility applies here too: `source` is text, not an
 * enum, because a provider or an operator-named source is added without a
 * migration (PRD decision 16).
 */

export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: primaryKeyId(),
    source: text("source").notNull(),
    deliveryId: text("delivery_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("webhook_delivery_source_delivery_unique").on(table.source, table.deliveryId),
    index("webhook_delivery_expires_at_idx").on(table.expiresAt),
  ],
);

export const oauthState = pgTable(
  "oauth_state",
  {
    id: primaryKeyId(),
    stateHash: text("state_hash").notNull(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("oauth_state_state_hash_unique").on(table.stateHash),
    index("oauth_state_space_id_idx").on(table.spaceId),
    index("oauth_state_user_id_idx").on(table.userId),
    index("oauth_state_expires_at_idx").on(table.expiresAt),
  ],
);
