import { Link, createFileRoute } from "@tanstack/react-router";
import { ComputerScreen } from "../../screens/computer.tsx";
import { useComputer } from "../../use-computer.ts";

/**
 * One bot's computer settings. The route is only the wiring: the bot id comes
 * from the URL, the transport from the router context, and the screen is a
 * function of the controller's state. A reload starts a fresh read, which is
 * the same durable read a write refreshes — a provider switch needs no
 * restart, and the choice is a stored row rather than a process setting.
 */
export const Route = createFileRoute("/_app/bots/$botId/computer")({
  component: ComputerRoute,
});

function ComputerRoute() {
  const { botId } = Route.useParams();
  const { computer } = Route.useRouteContext();
  const {
    state,
    load,
    choose,
    cancel,
    confirm,
    snapshot,
    restore,
    lifecycle,
    run,
    openDirectory,
    openFile,
    openParent,
  } = useComputer({
    transport: computer,
    botId,
  });

  return (
    <>
      <p className="muted">
        <Link to="/">Back to bots</Link>
      </p>
      <ComputerScreen
        state={state}
        onReload={load}
        onChoose={choose}
        onCancel={cancel}
        onConfirm={confirm}
        onSnapshot={snapshot}
        onRestore={restore}
        onLifecycle={lifecycle}
        onRun={run}
        onOpenDirectory={openDirectory}
        onOpenFile={openFile}
        onOpenParent={openParent}
      />
    </>
  );
}
