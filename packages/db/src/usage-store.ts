import { NotFoundError } from "@porkbot/effect";
import type { RunUsage, UsageRecorder } from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The durable half of the usage seam (slice 8.8, PRD story 34), over the
 * `usage_record` table.
 *
 * This is the one module that names the usage rows. The run runtime reaches
 * them through the `UsageRecorder` seam in `@porkbot/effect`, and
 * `usage-store.call-sites.test.ts` walks the shipped source and fails when the
 * table name appears anywhere else, so "one module owns the ledger" is checked
 * rather than promised. The factory splits by actor as the memory and
 * notification stores do:
 *
 *   - A `SystemActor` gets the write: one append per completed model turn,
 *     addressed by the run the adapter was executing. The statement selects
 *     the run's `space_id` and `bot_id` from the run row inside the insert, so
 *     the record can never disagree with the run it names, and a run outside
 *     the job's space writes nothing — the shared typed `NotFoundError`.
 *   - A `UserActor` gets the read: the all-time total for one bot and the
 *     daily buckets of the window the screen asks for. Both statements bind
 *     the actor's `space_id`, and the scoped bot pre-read makes a foreign bot
 *     the same refusal a missing one is.
 *
 * Null token fields are the "not reported" story and are preserved end to end:
 * the aggregate sums ignore nulls and return null when every row in the bucket
 * is null, so a period where the provider reported nothing answers `null`, not
 * `0`. The `reported`/`unreported` counts travel with every total so the
 * operator can see how much of a number is measured.
 *
 * Nothing here gates on the values: there is no budget read, no limit check,
 * and no call site that could charge. v1.0 records and displays token usage —
 * PRD out-of-scope, "Billing, usage metering enforcement, plans, or any payment
 * surface (#183)".
 */

/**
 * A bot's usage over one period (or over all time): the summed tokens and how
 * many calls stand behind the sums. `inputTokens`/`outputTokens` are null when
 * no call in the period reported that figure; a period with no calls at all has
 * `reported` and `unreported` both zero.
 */
export interface UsageTotals {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Calls where at least one token figure was reported. */
  readonly reported: number;
  /** Calls where the provider reported no usage at all. */
  readonly unreported: number;
}

/** One UTC day's totals. */
export interface UsagePeriod extends UsageTotals {
  readonly startsAt: Date;
}

/** The read a bot's usage screen makes: an all-time total plus the window's days. */
export interface UsageSummary {
  readonly total: UsageTotals;
  /** Newest day first; days with no calls are absent rather than zero-filled. */
  readonly periods: readonly UsagePeriod[];
}

export interface UsageReader {
  /**
   * One bot's usage: its all-time total and the daily buckets since `since`.
   * A bot outside the actor's space is the shared `NotFoundError`.
   */
  forBot(botId: string, options: { readonly since: Date }): Promise<UsageSummary>;
}

interface UsageTotalsRow {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reported: number;
  readonly unreported: number;
}

interface UsagePeriodRow extends UsageTotalsRow {
  readonly startsAt: Date;
}

export function createUsageStore(actor: SystemActor, database: Queryable): UsageRecorder;
export function createUsageStore(actor: UserActor, database: Queryable): UsageReader;
export function createUsageStore(actor: Actor, database: Queryable): UsageRecorder | UsageReader;
export function createUsageStore(actor: Actor, database: Queryable): UsageRecorder | UsageReader {
  if (actor.kind === "system") {
    return {
      async record(usage: RunUsage): Promise<void> {
        // The run's own columns are the source of the record's bot and space:
        // the insert takes them from the row rather than from the caller, and
        // the row's absence outside the job's space is the scoped not-found.
        const { rows } = await database.query<{ readonly id: string }>(
          "insert into usage_record (space_id, bot_id, run_id, provider, model, " +
            "input_tokens, output_tokens) " +
            "select r.space_id, r.bot_id, r.id, $3, $4, $5, $6 from run r " +
            "where r.id = $2 and r.space_id = $1 returning id",
          [
            actor.spaceId,
            usage.runId,
            usage.provider,
            usage.model,
            usage.inputTokens,
            usage.outputTokens,
          ],
        );

        if (rows.length === 0) {
          throw new NotFoundError("run", usage.runId);
        }
      },
    };
  }

  return {
    async forBot(botId: string, options: { readonly since: Date }): Promise<UsageSummary> {
      const { rows: bots } = await database.query<{ readonly id: string }>(
        "select id from bot where id = $1 and space_id = $2",
        [botId, actor.spaceId],
      );

      if (bots.length === 0) {
        throw new NotFoundError("bot", botId);
      }

      const { rows: totals } = await database.query<UsageTotalsRow>(
        `select ${usageTotalsColumns} from usage_record where space_id = $1 and bot_id = $2`,
        [actor.spaceId, botId],
      );

      const { rows: periods } = await database.query<UsagePeriodRow>(
        `select date_trunc('day', created_at, 'UTC') as "startsAt", ${usageTotalsColumns} ` +
          "from usage_record " +
          "where space_id = $1 and bot_id = $2 and created_at >= $3 " +
          'group by "startsAt" order by "startsAt" desc',
        [actor.spaceId, botId, options.since],
      );

      return {
        total: totals[0] ?? emptyTotals,
        periods,
      };
    },
  };
}

/**
 * The one aggregate projection both reads share: how many calls reported, how
 * many did not, and the sums of what was reported. `sum` over all-null rows is
 * SQL null, which is the "nothing was reported" answer the totals are built to
 * carry — never a coalesced zero.
 *
 * The `float8` cast is what keeps the driver's number type: `sum(integer)` is
 * `bigint`, which `pg` returns as a string. A token sum is exact in a double
 * far past any deployment's lifetime, so the cast trades nothing for a field
 * that reads as a number at every layer.
 */
const usageTotalsColumns =
  "count(*) filter (where input_tokens is not null or output_tokens is not null)::int " +
  'as "reported", ' +
  "count(*) filter (where input_tokens is null and output_tokens is null)::int " +
  'as "unreported", ' +
  'sum(input_tokens)::float8 as "inputTokens", ' +
  'sum(output_tokens)::float8 as "outputTokens"';

const emptyTotals: UsageTotals = {
  inputTokens: null,
  outputTokens: null,
  reported: 0,
  unreported: 0,
};
