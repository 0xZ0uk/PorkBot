import { Badge } from "@porkbot/ui";
import type { UsageBot, UsageTotalsView } from "@porkbot/contracts";

/**
 * One bot's recorded token usage (slice 13.12, story 34; design record,
 * Records): a report rather than a definition list.
 *
 * The report reads in two steps. The all-time total is a row of stat tiles —
 * input, output and calls — and the window's UTC days are bars whose length is
 * the day's reported tokens, split into the input and output segments, so the
 * shape of the spend is visible and not only its digits. The header carries
 * the informational mark the contract insists on: recorded and displayed only,
 * never metered or enforced.
 *
 * The settings surface (slice 11.5) renders the same report once per bot, so
 * the two surfaces cannot disagree about what a null figure means. That rule
 * is the report's one invariant: a null token figure is "Not reported", never
 * a zero, so a provider that stayed silent reads as unknown rather than free.
 * A window with no calls stays one sentence rather than thirty empty bars.
 */

export interface UsageScreenProps {
  readonly usage: UsageBot;
}

export function UsageScreen({ usage }: UsageScreenProps) {
  return (
    <section className="console usage-screen">
      <header className="memory-header">
        <div>
          <h2>Usage</h2>
          <p className="muted">Recorded and displayed only; nothing here is metered or enforced.</p>
        </div>
        <Badge tone="info">Informational</Badge>
      </header>
      <UsageReport usage={usage} />
    </section>
  );
}

/**
 * One bot's numbers, without the page around them: the all-time total as stat
 * tiles and the window's UTC days as bars, newest first. The settings surface
 * renders one of these per bot under the bot's name, and the per-bot route
 * renders one under its own heading, so both surfaces read the same figures
 * from one component.
 */
export function UsageReport({ usage }: UsageScreenProps) {
  const empty = usage.total.reported === 0 && usage.total.unreported === 0;

  if (empty) {
    return <p className="muted">No usage recorded yet.</p>;
  }

  return (
    <>
      <section className="usage-section" aria-label="All time">
        <h3 className="usage-section-title">All time</h3>
        <UsageStats totals={usage.total} />
      </section>

      <section className="usage-section" aria-label="Daily spend">
        <h3 className="usage-section-title">Daily spend</h3>
        {usage.periods.length === 0 ? (
          <p className="muted">No usage in this period.</p>
        ) : (
          <UsageChart periods={usage.periods} />
        )}
      </section>
    </>
  );
}

/** The three figures, as tiles: label above value, never a definition list. */
function UsageStats({ totals }: { readonly totals: UsageTotalsView }) {
  const calls = totals.reported + totals.unreported;
  const partial = totals.reported > 0 && totals.unreported > 0;

  return (
    <div className="usage-stats">
      <div className="usage-stat">
        <span className="usage-stat-label">Input tokens</span>
        <span className="usage-stat-value">{tokenText(totals.inputTokens)}</span>
      </div>
      <div className="usage-stat">
        <span className="usage-stat-label">Output tokens</span>
        <span className="usage-stat-value">{tokenText(totals.outputTokens)}</span>
      </div>
      <div className="usage-stat">
        <span className="usage-stat-label">Calls</span>
        <span className="usage-stat-value">{String(calls)}</span>
      </div>
      {partial ? (
        <p className="usage-partial muted">
          {String(totals.unreported)} of {String(calls)} not reported
        </p>
      ) : null}
    </div>
  );
}

/**
 * The window's days as bars, newest first. A bar's length is the day's
 * reported tokens against the busiest day in the window, and its two segments
 * are input and output, so a spike and a mix both read at a glance. A day
 * whose provider reported nothing has no length to draw, so it carries the
 * words instead of a zero bar.
 */
function UsageChart({ periods }: { readonly periods: UsageBot["periods"] }) {
  const totals = periods.map((period) => ({
    input: period.inputTokens ?? 0,
    output: period.outputTokens ?? 0,
  }));
  const busiest = Math.max(1, ...totals.map((total) => total.input + total.output));

  return (
    <figure className="usage-chart">
      <ul className="usage-bars">
        {periods.map((period, index) => {
          const total = totals[index] ?? { input: 0, output: 0 };
          const reported = period.inputTokens !== null || period.outputTokens !== null;

          return (
            <li key={period.startsAt} className="usage-bar-row">
              <time className="usage-bar-day muted" dateTime={period.startsAt}>
                {formatDay(period.startsAt)}
              </time>
              <span className="usage-bar-track">
                {reported ? (
                  <>
                    <span
                      className="usage-bar-segment usage-bar-segment--input"
                      style={{ width: `${String((total.input / busiest) * 100)}%` }}
                    />
                    <span
                      className="usage-bar-segment usage-bar-segment--output"
                      style={{ width: `${String((total.output / busiest) * 100)}%` }}
                    />
                  </>
                ) : null}
              </span>
              <span className="usage-bar-total">
                {reported ? tokenText(total.input + total.output) : "Not reported"}
              </span>
            </li>
          );
        })}
      </ul>
      <figcaption className="usage-legend muted">
        <span className="usage-swatch usage-swatch--input" aria-hidden="true" />
        Input
        <span className="usage-swatch usage-swatch--output" aria-hidden="true" />
        Output
      </figcaption>
    </figure>
  );
}

/** A reported count as digits; an unreported one as the only honest words. */
function tokenText(value: number | null): string {
  return value === null ? "Not reported" : String(value);
}

/** The UTC day the bucket starts at, as its own calendar date. */
function formatDay(startsAt: string): string {
  return startsAt.slice(0, 10);
}
