import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { run } from "./runs.ts";
import { space } from "./tenancy.ts";

/**
 * The computer lease (slice 7.4, PRD decisions 26 and 27).
 *
 * A run's commands reach their machine through `ComputerProvider.exec`, and
 * that seam deliberately carries no fence: the lease above it decides who may
 * command a computer. This table is that lease — one row per held computer,
 * addressed by `bot_id` so a second run of the same bot meets a taken lease
 * rather than a second writer, and bound to the run's own `(run_id, owner,
 * fence)` and live `lease_expires_at` so a reclaimed run's commands can no
 * longer renew or commit.
 *
 * The TTL is the safety margin: a lease is only ever taken from an expired
 * holder (or released, which only the holder and the watchdog may do), and the
 * module's `COMPUTER_LEASE_TTL_SECONDS` is asserted at the guard to be no
 * longer than the run lease's. That is what makes "a reclaimed run cannot
 * leave tools running in a sandbox" true: the old worker can no longer renew
 * once the fence moves, so its command ends within the same window the run
 * lease already allows, and the next owner waits for at most that window
 * instead of inheriting a live command.
 *
 * The unique index on `bot_id` is the whole mutual exclusion; there is no
 * read-then-write check. `owner`, `fence` and `expires_at` are NOT NULL because
 * a held lease always names its holder and its deadline — a nullable holder
 * would make the guard vacuous, the defect PRD decision 5 exists to prevent.
 */
export const computerLease = pgTable(
  "computer_lease",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    owner: text("owner").notNull(),
    fence: integer("fence").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("computer_lease_bot_id_unique").on(table.botId),
    index("computer_lease_space_id_idx").on(table.spaceId),
    index("computer_lease_run_id_idx").on(table.runId),
    index("computer_lease_expires_at_idx").on(table.expiresAt),
    check("computer_lease_owner_check", sql`length(btrim(${table.owner})) > 0`),
    check("computer_lease_fence_check", sql`${table.fence} >= 0`),
  ],
);
