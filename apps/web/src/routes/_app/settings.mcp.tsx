import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { McpScreen } from "../../screens/mcp.tsx";
import { useMcp } from "../../use-mcp.ts";
import type { McpTransport } from "../../mcp.ts";

/**
 * The MCP settings route. The loader fails closed when the process was
 * composed without the transport; the section below is a function of the
 * controller's state, and every write re-reads through the same transport, so
 * a server's status and its grants are the server's answers, not the screen's.
 */
export const Route = createFileRoute("/_app/settings/mcp")({
  loader: ({ context }) => {
    if (context.mcp === undefined) {
      throw new Error("the MCP transport is not configured");
    }
  },
  component: McpRoute,
  errorComponent: McpUnavailable,
});

function McpRoute() {
  const { mcp } = Route.useRouteContext();

  if (mcp === undefined) {
    return <McpUnavailable reset={() => undefined} />;
  }

  return <McpSection transport={mcp} />;
}

function McpSection({ transport }: { readonly transport: McpTransport }) {
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

function McpUnavailable({ reset }: { readonly reset: () => void }) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        MCP servers could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
