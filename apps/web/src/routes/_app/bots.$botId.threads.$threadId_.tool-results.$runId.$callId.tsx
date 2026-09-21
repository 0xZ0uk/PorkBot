import { createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { ToolResultScreen } from "../../screens/tool-result.tsx";

/**
 * One truncated tool event's artifact. The route is the wiring: the artifact
 * pointer in the URL is the whole address, and the loader resolves it through
 * the console transport, so a foreign or unsettled call is the API's typed
 * not-found and the error component answers it.
 *
 * The file name's trailing underscore makes this a sibling of the console
 * route rather than a child of it: the console route renders no outlet, so a
 * nested artifact would have appeared inside the transcript. The bot id is in
 * the path with the thread (slice 13.4) so the workspace's rail, header and
 * inspector are the same on the artifact as on the thread it came from.
 */
export const Route = createFileRoute(
  "/_app/bots/$botId/threads/$threadId_/tool-results/$runId/$callId",
)({
  loader: ({ context, params }) =>
    context.threads.toolResult({
      threadId: params.threadId,
      runId: params.runId,
      callId: params.callId,
    }),
  component: ToolResultRoute,
  errorComponent: ToolResultUnavailable,
});

function ToolResultRoute() {
  const { tool, result } = Route.useLoaderData();
  const { botId, threadId } = Route.useParams();

  return <ToolResultScreen botId={botId} threadId={threadId} tool={tool} result={result} />;
}

function ToolResultUnavailable({ reset }: ErrorComponentProps) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        The tool result could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
