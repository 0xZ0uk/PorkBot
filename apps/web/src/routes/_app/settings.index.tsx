import { createFileRoute } from "@tanstack/react-router";
import { SettingsScreen } from "../../screens/settings.tsx";

/**
 * The settings index. It reads no transport of its own: the page is a
 * directory of the surfaces below it, so a missing data source cannot make the
 * index itself unreachable.
 */
export const Route = createFileRoute("/_app/settings/")({
  component: SettingsRoute,
});

function SettingsRoute() {
  return <SettingsScreen />;
}
