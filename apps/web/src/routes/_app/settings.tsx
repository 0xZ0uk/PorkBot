import { createFileRoute } from "@tanstack/react-router";
import type { MemberRole } from "@porkbot/contracts";
import { AccountScreen } from "../../screens/account.tsx";
import { SettingsScreen } from "../../screens/settings.tsx";
import type { SettingsSection } from "../../screens/settings.tsx";
import {
  ConnectionsSection,
  McpSection,
  NotificationsSection,
  OwnershipUnavailable,
  SecretsSection,
  UnavailableSection,
  UsageSection,
} from "../../settings-sections.tsx";

/**
 * The settings surface's route (slice 13.13). It is the only settings route:
 * the six sections are anchors inside the panel, so there is one surface and
 * one place each value is read, and the old per-section paths are gone rather
 * than kept as second renderings of the same facts.
 *
 * The route is the wiring: it reads the transports from the router context and
 * the ownership read from its loader, then composes the six sections. A
 * transport the process was composed without becomes that section's own
 * unavailable line instead of a route-level error, so one missing data source
 * cannot blank the panel.
 */

export interface OwnershipData {
  readonly ownership: { readonly role: MemberRole; readonly ownerEmail: string | null } | null;
  readonly ownershipFailed: boolean;
}

export const Route = createFileRoute("/_app/settings")({
  loader: async ({ context }): Promise<OwnershipData> => {
    if (context.ownership === undefined) {
      return { ownership: null, ownershipFailed: true };
    }

    try {
      return { ownership: await context.ownership.ownership(), ownershipFailed: false };
    } catch {
      return { ownership: null, ownershipFailed: true };
    }
  },
  component: SettingsRoute,
});

function SettingsRoute() {
  const { connections, mcp, secrets, notifications, bots, usage } = Route.useRouteContext();
  const { ownership } = Route.useLoaderData();

  const sections: readonly SettingsSection[] = [
    {
      id: "models",
      label: "Models and connections",
      content: <ConnectionsSection transport={connections} />,
    },
    {
      id: "mcp",
      label: "MCP servers",
      content:
        mcp === undefined ? (
          <UnavailableSection message="MCP servers could not be loaded." />
        ) : (
          <McpSection transport={mcp} />
        ),
    },
    {
      id: "secrets",
      label: "Secrets",
      content:
        secrets === undefined ? (
          <UnavailableSection message="Secrets could not be loaded." />
        ) : (
          <SecretsSection transport={secrets} />
        ),
    },
    {
      id: "notifications",
      label: "Notifications",
      content:
        notifications === undefined ? (
          <UnavailableSection message="Notification settings could not be loaded." />
        ) : (
          <NotificationsSection transport={notifications} />
        ),
    },
    {
      id: "usage",
      label: "Usage",
      content: <UsageSection bots={bots} usage={usage} />,
    },
    {
      id: "account",
      label: "Account",
      content:
        ownership === null ? (
          <OwnershipUnavailable />
        ) : (
          <AccountScreen role={ownership.role} ownerEmail={ownership.ownerEmail} />
        ),
    },
  ];

  return <SettingsScreen sections={sections} />;
}
