import type { UsageBot, UsageTotalsView } from "@porkbot/contracts";
import type { UsageSummary, UsageTotals } from "@porkbot/db";
import { authenticated } from "../gate.ts";

/**
 * The usage router (slice 8.8, PRD story 34): one bot's recorded token usage,
 * as an all-time total and a series of UTC-day buckets.
 *
 * The read is display-only. Nothing here charges, meters or enforces — the
 * contract has no budget or plan field, and the PRD's out-of-scope list makes
 * "recorded and displayed, not charged" the v1.0 rule (#183). The repository
 * binds the actor's space, so a foreign or missing bot is the contract's typed
 * `NOT_FOUND`.
 *
 * The window starts at the UTC midnight `days - 1` days back, so asking for 30
 * days is 30 buckets ending with today rather than 29 days plus a partial
 * sliver. The all-time total is deliberately not windowed: what a bot has cost
 * is not a question the window answers.
 */
export function createUsageRouter() {
  const bot = authenticated.usage.bot.handler(async ({ input, context }) =>
    usageOutput(
      input.botId,
      await context.repositories.usage.forBot(input.botId, {
        since: windowStart(input.days, new Date()),
      }),
    ),
  );

  return authenticated.usage.router({ bot });
}

/** The UTC midnight that begins a `days`-long window ending with today. */
function windowStart(days: number, now: Date): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return start;
}

/** The row-to-wire mapping; the contract's schema is the only output shape. */
function usageOutput(botId: string, summary: UsageSummary): UsageBot {
  return {
    botId,
    total: totalsOutput(summary.total),
    periods: summary.periods.map((period) => ({
      startsAt: period.startsAt.toISOString(),
      ...totalsOutput(period),
    })),
  };
}

function totalsOutput(totals: UsageTotals): UsageTotalsView {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    reported: totals.reported,
    unreported: totals.unreported,
  };
}
