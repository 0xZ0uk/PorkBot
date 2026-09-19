import { Link, createFileRoute } from "@tanstack/react-router";
import { ConnectionsScreen } from "../../screens/connections.tsx";
import { useConnections } from "../../use-connections.ts";

/**
 * The connections settings route. The route is only the wiring: the transport
 * comes from the router context and the screen is a function of the
 * controller's state. Every mutation re-reads through the same transport, so a
 * revoke, a disconnect or a new default is visible on the next render without
 * a restart.
 */
export const Route = createFileRoute("/_app/settings/connections")({
  component: ConnectionsRoute,
});

function ConnectionsRoute() {
  const { connections } = Route.useRouteContext();
  const { state, load, probe, setDefault, disconnect, revoke, create, setBotConnection } =
    useConnections({ transport: connections });

  return (
    <>
      <p className="muted">
        <Link to="/">Back to bots</Link>
      </p>
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
    </>
  );
}
