import { createFileRoute } from "@tanstack/react-router";
import { ComposerScreen } from "../../screens/composer.tsx";
import { ThreadConsoleScreen } from "../../screens/thread-console.tsx";
import { useComposer } from "../../use-composer.ts";
import { useThreadConsole } from "../../use-console.ts";

/**
 * One thread's console. The route is only the wiring: the thread id comes from
 * the URL, the transport from the router context, and everything the screen
 * shows is the console controller's state. A reload of this route starts a
 * fresh console, which replays the thread's durable events from zero — the
 * resume path story 19 asks for.
 *
 * The composer below it shares the console through `noteSent` (slice 11.3): a
 * send's persisted message folds straight into the transcript rather than
 * waiting for a stream that does not carry run-starting messages, and its
 * attachments render from the same file blocks a reload would read.
 */
export const Route = createFileRoute("/_app/threads/$threadId")({
  component: ThreadConsoleRoute,
});

function ThreadConsoleRoute() {
  const { threadId } = Route.useParams();
  const { threads, approvals } = Route.useRouteContext();
  const { state, retry, noteSent } = useThreadConsole({ transport: threads, threadId });
  const composer = useComposer(threads, threadId, noteSent);

  return (
    <>
      <ThreadConsoleScreen
        state={state}
        onRetry={retry}
        {...(approvals === undefined
          ? {}
          : {
              onApprovalDecision: async (
                input: Parameters<NonNullable<typeof approvals>["decide"]>[0],
              ) => {
                await approvals.decide(input);
              },
            })}
      />
      <ComposerScreen
        state={composer.state}
        onText={composer.setText}
        onFiles={composer.addFiles}
        onRemoveFile={composer.removeFile}
        onRetryFile={composer.retryFile}
        onSend={composer.send}
        onDragActive={composer.setDragActive}
      />
    </>
  );
}
