import { createFileRoute } from "@tanstack/react-router";
import { SettingsUsageScreen } from "../../screens/settings-usage.tsx";
import { useSettingsUsage } from "../../use-settings-usage.ts";

/**
 * The usage settings route. The read fans out over the bots the shell already
 * lists, through the same usage transport the per-bot route uses, so the
 * window choice and the numbers are the contract's in both places.
 */
export const Route = createFileRoute("/_app/settings/usage")({
  component: SettingsUsageRoute,
});

function SettingsUsageRoute() {
  const { bots, usage } = Route.useRouteContext();
  const { state, load, setDays } = useSettingsUsage({ bots, usage });

  return <SettingsUsageScreen state={state} onReload={load} onDays={setDays} />;
}
