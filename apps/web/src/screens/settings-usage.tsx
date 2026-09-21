import { Button, Field, Select } from "@porkbot/ui";
import { UsageReport } from "./usage.tsx";
import { usageWindows } from "../settings-usage.ts";
import type { SettingsUsageState, UsageWindow } from "../settings-usage.ts";
import { UsageSkeleton } from "./loading.tsx";

/**
 * Usage settings (slice 11.5, story 34): every active bot's recorded totals
 * over one window, each bot's daily buckets under its all-time total.
 *
 * The screen says out loud what the contract says: the numbers are recorded
 * and displayed only. There is no budget, limit or plan field here because
 * there is none on the wire, and the sentence exists so a total is never
 * mistaken for a meter. The window choice re-reads every bot; while it does,
 * the table stays visible and only the control is held.
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
        <h2>Usage</h2>
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
      </header>
      <p className="muted">Recorded and displayed only; nothing here is metered or enforced.</p>

      {state.reports.length === 0 ? (
        <p className="muted">No bots yet.</p>
      ) : (
        state.reports.map(({ bot, usage }) => (
          <section key={bot.id} className="settings-usage-bot">
            <h3>{bot.name}</h3>
            <UsageReport usage={usage} />
          </section>
        ))
      )}
    </section>
  );
}
