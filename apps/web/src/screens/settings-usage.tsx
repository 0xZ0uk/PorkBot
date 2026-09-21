import { Badge, BotAvatar, Button, Field, Select } from "@porkbot/ui";
import { UsageReport } from "./usage.tsx";
import { usageWindows } from "../settings-usage.ts";
import type { BotUsage, SettingsUsageState, UsageWindow } from "../settings-usage.ts";
import { UsageSkeleton } from "./loading.tsx";

/**
 * Usage settings (slice 13.12, story 34; design record, Records): every active
 * bot's recorded totals over one window, as a report rather than a definition
 * list.
 *
 * The screen opens with the comparison: one bar per bot, its length the bot's
 * reported tokens against the busiest teammate, so "who costs the most" is a
 * shape before it is a number. Each bot then gets the same report the per-bot
 * route renders — stat tiles and daily bars — under its own name and avatar.
 *
 * The screen says out loud what the contract says: the numbers are recorded
 * and displayed only. There is no budget, limit or plan field here because
 * there is none on the wire, and the informational mark exists so a total is
 * never mistaken for a meter. The window choice re-reads every bot; while it
 * does, the report stays visible and only the control is held.
 */

export interface SettingsUsageScreenProps {
  readonly state: SettingsUsageState;
  readonly onReload: () => void;
  readonly onDays: (days: UsageWindow) => void;
}

function windowLabel(days: UsageWindow): string {
  return `Last ${String(days)} days`;
}

export function SettingsUsageScreen({ state, onReload, onDays }: SettingsUsageScreenProps) {
  if (state.status === "refused") {
    return (
      <section className="console">
        <p className="form-error" role="alert">
          {state.refusal}
        </p>
        <Button onClick={onReload}>Try again</Button>
      </section>
    );
  }

  if (state.status === "loading") {
    return <UsageSkeleton />;
  }

  return (
    <section className="console">
      <header className="memory-header">
        <div>
          <h2>Usage</h2>
          <p className="muted">Recorded and displayed only; nothing here is metered or enforced.</p>
        </div>
        <div className="usage-controls">
          <Badge tone="info">Informational</Badge>
          <Field label="Window">
            <Select
              value={state.days}
              disabled={state.reloading}
              onChange={(event) => {
                onDays(Number(event.target.value) as UsageWindow);
              }}
            >
              {usageWindows.map((days) => (
                <option key={days} value={days}>
                  {windowLabel(days)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </header>

      {state.reports.length === 0 ? (
        <p className="muted">No bots yet.</p>
      ) : (
        <>
          <section className="usage-section" aria-label="By bot">
            <h3 className="usage-section-title">By bot</h3>
            <UsageComparison reports={state.reports} />
          </section>

          {state.reports.map(({ bot, usage }) => (
            <section key={bot.id} className="usage-bot" aria-label={bot.name}>
              <header className="usage-bot-header">
                <BotAvatar id={bot.id} name={bot.name} color={bot.color} size={24} />
                <h3 className="usage-section-title">{bot.name}</h3>
              </header>
              <UsageReport usage={usage} />
            </section>
          ))}
        </>
      )}
    </section>
  );
}

/**
 * Every bot's all-time reported tokens as one bar each, longest first is not
 * imposed — the roster's order is the operator's — so the bar answers "how
 * much" without reordering the teammates under the reader. A bot with no
 * calls says so in words rather than drawing a zero-length bar.
 */
function UsageComparison({ reports }: { readonly reports: readonly BotUsage[] }) {
  const totals = reports.map(
    ({ usage }) => (usage.total.inputTokens ?? 0) + (usage.total.outputTokens ?? 0),
  );
  const busiest = Math.max(1, ...totals);

  return (
    <ul className="usage-bars usage-bars--bots">
      {reports.map(({ bot, usage }, index) => {
        const calls = usage.total.reported + usage.total.unreported;
        const total = totals[index] ?? 0;

        return (
          <li key={bot.id} className="usage-bar-row">
            <span className="usage-bar-day">{bot.name}</span>
            <span className="usage-bar-track">
              {calls === 0 ? null : (
                <span
                  className="usage-bar-segment usage-bar-segment--input"
                  style={{ width: `${String((total / busiest) * 100)}%` }}
                />
              )}
            </span>
            <span className="usage-bar-total">
              {calls === 0 ? "No calls" : total === 0 ? "Not reported" : String(total)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
