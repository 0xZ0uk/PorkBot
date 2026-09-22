import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import type { Message } from "@porkbot/contracts";
import { findRosterBot } from "../../roster.ts";
import { ComposerScreen } from "../../screens/composer.tsx";
import { ThreadConsoleScreen } from "../../screens/thread-console.tsx";
import { stateFromLiveness } from "../../shell/bot-state.ts";
import { useShellHeaderState } from "../../shell/header-state.tsx";
import { useComposer } from "../../use-composer.ts";
import { useThreadConsole } from "../../use-console.ts";
import { useRunNotifications } from "../../use-run-notifications.ts";
import { useCallback } from "react";

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
 * workspace as a click through the rail. The selected bot comes from the
 * shell's roster read, so the console's attribution and the composer's
 * placeholder name the same bot the header does.
 *
 * The composer below the transcript shares optimistic send callbacks with the
 * console (slice 11.3): a local message appears immediately, settles in place
 * when persistence returns, and keeps its position when the send fails. Its
 * attachments render from the same file blocks a reload would read.
 * The composer's stop control (slice 13.7) asks the console to stop the active
 * run, and the console's failure sentence is the composer's alert.
 *
 * The console's live run state is reported to the shell's header, which cannot
 * subscribe to the run itself; an approval decision re-reads the shell's
 * pending count rather than leaving the rail's badge stale.
 */
export const Route = createFileRoute("/_app/bots/$botId/threads/$threadId")({
  component: ThreadConsoleRoute,
});

const appRoute = getRouteApi("/_app");

function ThreadConsoleRoute() {
  const { botId, threadId } = Route.useParams();
  const { threads, approvals } = Route.useRouteContext();
  const { roster } = appRoute.useLoaderData();
  const router = useRouter();
  const { state, retry, noteOptimistic, settleSent, failSent, stopRun } = useThreadConsole({
    transport: threads,
    threadId,
  });
  const settleSentForComposer = useCallback(
    (message: Message, optimisticId: string) => {
      settleSent(optimisticId, message);
    },
    [settleSent],
  );
  const composer = useComposer(threads, threadId, {
    onOptimistic: noteOptimistic,
    onSent: settleSentForComposer,
    onSendFailed: failSent,
  });
  const bot = findRosterBot(roster, botId);

  useRunNotifications({ state, botId });

  useShellHeaderState(stateFromLiveness(state.liveness));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadConsoleScreen
        botId={botId}
        state={state}
        {...(bot === null ? {} : { bot })}
        onRetry={retry}
        {...(approvals === undefined
          ? {}
          : {
              onApprovalDecision: async (
                input: Parameters<NonNullable<typeof approvals>["decide"]>[0],
              ) => {
                const result = await approvals.decide(input);
                // The shell's pending count re-reads with the decision; the
                // card itself settles from the returned row, so a vote answers
                // before the run's own event has made the round trip.
                await router.invalidate();

                return result.approval;
              },
            })}
      />
      <ComposerScreen
        state={composer.state}
        {...(bot === null ? {} : { botName: bot.name })}
        canStop={state.activeRunId !== null}
        stopping={state.stopping}
        stopError={state.stopError}
        onStop={stopRun}
        onText={composer.setText}
        onFiles={composer.addFiles}
        onRemoveFile={composer.removeFile}
        onRetryFile={composer.retryFile}
        onSend={composer.send}
        onDragActive={composer.setDragActive}
      />
    </div>
  );
}
