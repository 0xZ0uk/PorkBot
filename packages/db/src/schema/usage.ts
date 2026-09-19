import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId } from "./columns.ts";
import { run } from "./runs.ts";
import { space } from "./tenancy.ts";

/**
 * One model call's token usage, recorded for display (slice 8.8, PRD story 34;
 * PRD out-of-scope line for billing, #183).
 *
 * A row is appended when an assistant turn completes, not when the run settles,
 * so a run that fails or is cancelled keeps the usage its completed turns
 * already spent — partial usage is the normal case, never a loss. The row names
 * the run that produced it and the provider and model that reported it, so the
 * per-bot and per-period totals the screen shows can be recomputed from the
 * ledger rather than trusted from an aggregate.
 *
 * `input_tokens` and `output_tokens` are nullable, and that null is the whole
 * "not reported" story: a provider that does not report usage leaves them
 * unknown, which is a different fact from a reported zero and must never be
 * rendered as one. The adapter boundary degrades an unknown report to these
 * nulls rather than inventing numbers.
 *
 * This table is a display ledger, not a meter: nothing reads it for admission,
 * retries, budgets or payment (PRD out-of-scope: token usage is recorded and
 * displayed, not charged). The schema states that in the only way a table can —
 * it has no column a gate could read a limit from.
 *
 * The bot and the run are both `on delete cascade`, so deleting a bot or a run
 * removes its usage with it; the `(bot_id, created_at)` index is the read the
 * screen makes, and the two remaining indexes cover the foreign keys (PRD
 * decision 16's "every lookup foreign key is indexed").
 */
export const usageRecord = pgTable(
  "usage_record",
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
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("usage_record_bot_created_idx").on(table.botId, table.createdAt),
    index("usage_record_run_id_idx").on(table.runId),
    index("usage_record_space_id_idx").on(table.spaceId),
    check(
      "usage_record_provider_check",
      sql`${table.provider} is null or length(btrim(${table.provider})) > 0`,
    ),
    check(
      "usage_record_model_check",
      sql`${table.model} is null or length(btrim(${table.model})) > 0`,
    ),
    check(
      "usage_record_input_tokens_check",
      sql`${table.inputTokens} is null or ${table.inputTokens} >= 0`,
    ),
    check(
      "usage_record_output_tokens_check",
      sql`${table.outputTokens} is null or ${table.outputTokens} >= 0`,
    ),
  ],
);
