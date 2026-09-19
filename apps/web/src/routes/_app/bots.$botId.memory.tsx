import { Link, createFileRoute } from "@tanstack/react-router";
import { MemoryScreen } from "../../screens/memory.tsx";
import { useMemory } from "../../use-memory.ts";

/**
 * One bot's memory. The route is only the wiring: the bot id comes from the
 * URL, the transport from the router context, and the screen is a function of
 * the controller's state. A reload of this route starts a fresh load, which is
 * the same durable read a mutation refreshes — editing memory never needs a
 * restart or a run to take effect.
 */
export const Route = createFileRoute("/_app/bots/$botId/memory")({
  component: MemoryRoute,
});

function MemoryRoute() {
  const { botId } = Route.useParams();
  const { memory } = Route.useRouteContext();
  const { state, load, setScope, toggleHistory, save, remove, restore } = useMemory({
    transport: memory,
    botId,
  });

  return (
    <>
      <p className="muted">
        <Link to="/">Back to bots</Link>
      </p>
      <MemoryScreen
        state={state}
        onScope={setScope}
        onRetry={load}
        onToggleHistory={toggleHistory}
        onSave={save}
        onRemove={remove}
        onRestore={restore}
      />
    </>
  );
}
