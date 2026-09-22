import { useRouter } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { ConnectionsScreen } from "./screens/connections.tsx";
import { McpScreen } from "./screens/mcp.tsx";
import { NotificationsScreen } from "./screens/notifications.tsx";
import { SecretsScreen } from "./screens/secrets.tsx";
import { SettingsUsageScreen } from "./screens/settings-usage.tsx";
import { useConnections } from "./use-connections.ts";
import { useMcp } from "./use-mcp.ts";
import { useNotifications } from "./use-notifications.ts";
import { useSecrets } from "./use-secrets.ts";
import { useSettingsUsage } from "./use-settings-usage.ts";
import type { BotsTransport } from "./bots.ts";
import type { ConnectionsTransport } from "./connections.ts";
import type { McpTransport } from "./mcp.ts";
import type { NotificationsTransport } from "./notifications.ts";
import type { SecretsTransport } from "./secrets.ts";
import type { UsageTransport } from "./transport.ts";

/**
 * The settings surface's sections, each wired to its controller (slice 13.13).
 *
 * The old per-section routes each owned one transport and one controller; the
 * one surface keeps that wiring, one component per section, so the panel itself
 * stays a rendering of state and no section reaches for a transport the route
 * did not pass it. A transport the process was composed without renders the
 * section's own unavailable line rather than taking the panel down with it.
 */

export interface UnavailableSectionProps {
  readonly message: string;
  readonly onRetry?: (() => void) | undefined;
}

/** A section whose data source refused or was never composed. */
export function UnavailableSection({ message, onRetry }: UnavailableSectionProps) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <p className="rounded-md border border-destructive bg-card p-2 text-foreground" role="alert">
        {message}
      </p>
      {onRetry === undefined ? null : <Button onClick={onRetry}>Try again</Button>}
    </section>
  );
}

export function ConnectionsSection({ transport }: { readonly transport: ConnectionsTransport }) {
  const { state, load, probe, setDefault, disconnect, revoke, create, setBotConnection } =
    useConnections({ transport });

  return (
    <ConnectionsScreen
      state={state}
      onReload={load}
      onProbe={(id) => {
        void probe(id);
      }}
      onSetDefault={setDefault}
      onDisconnect={disconnect}
      onRevoke={revoke}
      onCreate={create}
      onSetBotConnection={setBotConnection}
    />
  );
}

export function McpSection({ transport }: { readonly transport: McpTransport }) {
  const { state, load, open, close, install, remove, grant, revokeGrant, recheck } = useMcp({
    transport,
  });

  return (
    <McpScreen
      state={state}
      onReload={load}
      onOpen={(id) => {
        void open(id);
      }}
      onClose={close}
      onInstall={install}
      onRemove={remove}
      onGrant={grant}
      onRevokeGrant={revokeGrant}
      onRecheck={() => {
        void recheck();
      }}
    />
  );
}

export function SecretsSection({ transport }: { readonly transport: SecretsTransport }) {
  const { state, load, selectBot, store, forget } = useSecrets({ transport });

  return (
    <SecretsScreen
      state={state}
      onReload={load}
      onSelectBot={(botId) => {
        void selectBot(botId);
      }}
      onStore={store}
      onForget={forget}
    />
  );
}

export function NotificationsSection({
  transport,
}: {
  readonly transport: NotificationsTransport;
}) {
  const { state, load, setPreference } = useNotifications({ transport });

  return (
    <NotificationsScreen
      state={state}
      onReload={load}
      onToggle={(kind, enabled) => {
        void setPreference(kind, enabled);
      }}
    />
  );
}

export interface UsageSectionProps {
  readonly bots: BotsTransport;
  readonly usage: UsageTransport;
}

export function UsageSection({ bots, usage }: UsageSectionProps) {
  const { state, load, setDays } = useSettingsUsage({ bots, usage });

  return <SettingsUsageScreen state={state} onReload={load} onDays={setDays} />;
}

/** Re-reads the panel's loader after an ownership read failed. */
export function OwnershipUnavailable() {
  const router = useRouter();

  return (
    <UnavailableSection
      message="Account details could not be loaded."
      onRetry={() => {
        void router.invalidate();
      }}
    />
  );
}
