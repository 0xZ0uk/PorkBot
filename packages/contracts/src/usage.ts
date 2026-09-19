import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The usage module (slice 8.8, PRD story 34): what a bot's recorded model
 * calls spent, shown so the operator knows what a teammate costs.
 *
 * The read is deliberately two shapes in one answer. `total` is all-time, which
 * is the "what has this bot cost me" number; `periods` is a UTC-day series over
 * the requested window, which is the "when" the screen plots. Days with no
 * calls are absent rather than zero-filled, so "nothing ran" stays distinct
 * from "ran and reported nothing".
 *
 * Every token figure is nullable, and that null is the contract's whole "not
 * reported" vocabulary: a provider that does not report usage leaves the figure
 * unknown, the aggregate keeps it null, and the client renders "not reported"
 * rather than a zero nobody measured. The `reported`/`unreported` counts say
 * how many calls stand behind a total, so an incomplete number can say so.
 *
 * Nothing in this contract charges, meters or enforces: recorded and displayed
 * only (PRD out-of-scope, #183). There is no limit, budget or plan field for a
 * client to mistake for one.
 */

export const usageTotalsSchema = z.object({
  /** Sum of reported input tokens, or `null` when no call reported any. */
  inputTokens: z.number().int().nonnegative().nullable(),
  /** Sum of reported output tokens, or `null` when no call reported any. */
  outputTokens: z.number().int().nonnegative().nullable(),
  /** Calls whose provider reported at least one figure. */
  reported: z.number().int().nonnegative(),
  /** Calls whose provider reported nothing at all. */
  unreported: z.number().int().nonnegative(),
});

export const usagePeriodSchema = usageTotalsSchema.extend({
  /** The UTC midnight the day starts at, ISO 8601. */
  startsAt: z.iso.datetime(),
});

export type UsageTotalsView = z.infer<typeof usageTotalsSchema>;
export type UsagePeriodView = z.infer<typeof usagePeriodSchema>;

export const usageBotSchema = z.object({
  botId: z.string().min(1),
  total: usageTotalsSchema,
  /** Newest day first; a day with no calls is absent, never a zero row. */
  periods: z.array(usagePeriodSchema),
});

export type UsageBot = z.infer<typeof usageBotSchema>;

export const usageBotContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/usage",
    operationId: "usageBot",
    summary: "A bot's token usage: all-time totals and daily buckets",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      /** How many days back the daily buckets reach; the total is all-time. */
      days: z.number().int().min(1).max(365).default(30),
    }),
  )
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(usageBotSchema);
