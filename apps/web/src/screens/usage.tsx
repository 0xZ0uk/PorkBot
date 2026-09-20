import type { UsageBot, UsageTotalsView } from "@porkbot/contracts";

/**
 * One bot's recorded token usage (slice 8.8, story 34): the all-time total and
 * the window's UTC days, newest first. The settings surface (slice 11.5)
 * renders the same report once per bot, so the two surfaces cannot disagree
 * about what a null figure means.
 *
 * The screen is a plain function of the contract's answer. It has one rule the
 * numbers depend on: a null token figure is "Not reported", never a zero, so a
 * provider that stayed silent reads as unknown rather than free. A day list
 * that is empty stays a sentence rather than thirty zero rows.
 */

export interface UsageScreenProps {
  readonly usage: UsageBot;
}

export function UsageScreen({ usage }: UsageScreenProps) {
  return (
    <section className="console">
      <h2>Usage</h2>
      <UsageReport usage={usage} />
    </section>
  );
}

/**
 * One bot's numbers, without the page around them: the all-time total and the
 * window's UTC days, newest first. The settings surface renders one of these
 * per bot under the bot's name, and the per-bot route renders one under its
 * own heading, so both surfaces read the same figures from one component.
 */
export function UsageReport({ usage }: UsageScreenProps) {
  const empty = usage.total.reported === 0 && usage.total.unreported === 0;

  if (empty) {
    return <p className="muted">No usage recorded yet.</p>;
  }

  return (
    <>
      <UsageTotals totals={usage.total} heading="All time" />
      {usage.periods.length === 0 ? (
        <p className="muted">No usage in this period.</p>
      ) : (
        <ul className="usage-list">
          {usage.periods.map((period) => (
            <li key={period.startsAt} className="usage-period">
              <UsageTotals totals={period} heading={formatDay(period.startsAt)} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * One period's numbers. The partial-coverage sentence only appears when some
 * calls reported and some did not; when nothing reported, the figures already
 * say "Not reported" and the count would only repeat them.
 */
function UsageTotals({ totals, heading }: { totals: UsageTotalsView; heading: string }) {
  const calls = totals.reported + totals.unreported;
  const partial = totals.reported > 0 && totals.unreported > 0;

  return (
    <div className="usage-totals">
      <h3>{heading}</h3>
      <dl>
        <dt>Input</dt>
        <dd>{tokenText(totals.inputTokens)}</dd>
        <dt>Output</dt>
        <dd>{tokenText(totals.outputTokens)}</dd>
        <dt>Calls</dt>
        <dd>{String(calls)}</dd>
      </dl>
      {partial ? (
        <p className="muted">
          {String(totals.unreported)} of {String(calls)} not reported
        </p>
      ) : null}
    </div>
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
