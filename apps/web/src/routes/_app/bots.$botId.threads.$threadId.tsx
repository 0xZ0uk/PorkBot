import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ComposerScreen } from "../../screens/composer.tsx";
import { ThreadConsoleScreen } from "../../screens/thread-console.tsx";
import { stateFromLiveness } from "../../shell/bot-state.ts";
import { useShellHeaderState } from "../../shell/header-state.tsx";
import { useComposer } from "../../use-composer.ts";
import { useThreadConsole } from "../../use-console.ts";

/**
 * One thread's console. The route is only the wiring: the bot and thread ids
 * come from the URL, the transport from the router context, and everything the
 * screen shows is the console controller's state. A reload of this route starts
 * a fresh console, which replays the thread's durable events from zero — the
 * resume path story 19 asks for.
 *
 * The thread is addressed under its bot (slice 13.4) because the workspace is
 * bot-centric: the rail's active row, the header's identity and the inspector
 * are all read from the URL, so a reload of a thread URL renders the same
 * workspace as a click through the rail.
 *
 * The composer below it shares the console through `noteSent` (slice 11.3): a
 * send's persisted message folds straight into the transcript rather than
 * waiting for a stream that does not carry run-starting messages, and its
 * attachments render from the same file blocks a reload would read.
 *
 * The console's live run state is reported to the shell's header, which cannot
 * subscribe to the run itself; an approval decision re-reads the shell's
 * pending count rather than leaving the rail's badge stale.
 */
export const Route = createFileRoute("/_app/bots/$botId/threads/$threadId")({
  component: ThreadConsoleRoute,
});

function ThreadConsoleRoute() {
  const { botId, threadId } = Route.useParams();
  const { threads, approvals } = Route.useRouteContext();
  const router = useRouter();
  const { state, retry, noteSent } = useThreadConsole({ transport: threads, threadId });
  const composer = useComposer(threads, threadId, noteSent);

  useShellHeaderState(stateFromLiveness(state.liveness));

  return (
    <>
      <ThreadConsoleScreen
        botId={botId}
        state={state}
        onRetry={retry}
        {...(approvals === undefined
          ? {}
          : {
              onApprovalDecision: async (
                input: Parameters<NonNullable<typeof approvals>["decide"]>[0],
              ) => {
                await approvals.decide(input);
                await router.invalidate();
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
