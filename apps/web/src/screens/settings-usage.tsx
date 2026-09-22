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
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        <p className="rounded-md border border-destructive bg-card p-2 text-foreground" role="alert">
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
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div>
          <h2>Usage</h2>
          <p className="text-muted-foreground">Recorded and displayed only; nothing here is metered or enforced.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
        <p className="text-muted-foreground">No bots yet.</p>
      ) : (
        <>
          <section className="flex flex-col gap-2" aria-label="By bot">
            <h3 className="m-0 text-heading">By bot</h3>
            <UsageComparison reports={state.reports} />
          </section>

          {state.reports.map(({ bot, usage }) => (
            <section key={bot.id} className="flex flex-col gap-2" aria-label={bot.name}>
              <header className="flex flex-wrap items-center gap-2">
                <BotAvatar id={bot.id} name={bot.name} color={bot.color} size={24} />
                <h3 className="m-0 text-heading">{bot.name}</h3>
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
    <ul className="flex flex-col gap-2 gap-3">
      {reports.map(({ bot, usage }, index) => {
        const calls = usage.total.reported + usage.total.unreported;
        const total = totals[index] ?? 0;

        return (
          <li key={bot.id} className="flex items-center gap-2">
            <span className="w-20 flex-none text-meta text-muted-foreground">{bot.name}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-accent">
              {calls === 0 ? null : (
                <span
                  className="h-full bg-primary"
                  style={{ width: `${String((total / busiest) * 100)}%` }}
                />
              )}
            </span>
            <span className="w-16 flex-none text-right text-meta text-muted-foreground">
              {calls === 0 ? "No calls" : total === 0 ? "Not reported" : String(total)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
