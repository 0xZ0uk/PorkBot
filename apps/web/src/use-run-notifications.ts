import { useEffect, useRef } from "react";
import { useToast } from "@porkbot/ui";
import type { RunStatus } from "@porkbot/core";
import type { ThreadConsoleState, TranscriptRunEntry } from "./console.ts";

interface RunNotificationOptions {
  readonly state: ThreadConsoleState;
  readonly botId: string;
}

type NotifiedRunState = "completed" | "failed" | "stuck";

/** Announces live run transitions while leaving the initial transcript quiet. */
export function useRunNotifications({ state, botId }: RunNotificationOptions): void {
  const toast = useToast();
  const initialized = useRef(false);
  const notified = useRef(new Map<string, NotifiedRunState>());

  useEffect(() => {
    if (state.status !== "ready") {
      return;
    }

    const terminalRuns =
      state.terminalRuns ??
      state.entries
        .filter((entry): entry is TranscriptRunEntry => entry.kind === "run")
        .map((entry) => entry.run);

    if (!initialized.current) {
      for (const run of terminalRuns) {
        const status = notificationStatus(run.status);

        if (status !== null) {
          notified.current.set(run.runId, status);
        }
      }

      if (state.activeRunId !== null && state.liveness?.state === "stuck") {
        notified.current.set(state.activeRunId, "stuck");
      }

      initialized.current = true;
      return;
    }

    for (const run of terminalRuns) {
      const status = notificationStatus(run.status);

      if (status === null || notified.current.get(run.runId) === status) {
        continue;
      }

      notified.current.set(run.runId, status);
      pushRunToast(toast.push, botId, state.threadId, run.runId, status);
    }

    if (
      state.activeRunId !== null &&
      state.liveness?.state === "stuck" &&
      notified.current.get(state.activeRunId) !== "stuck"
    ) {
      notified.current.set(state.activeRunId, "stuck");
      pushRunToast(toast.push, botId, state.threadId, state.activeRunId, "stuck");
    }
  }, [botId, state, toast]);
}

function notificationStatus(status: RunStatus): NotifiedRunState | null {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function pushRunToast(
  push: ReturnType<typeof useToast>["push"],
  botId: string,
  threadId: string,
  runId: string,
  status: NotifiedRunState,
): void {
  const copy = {
    completed: {
      title: "Run finished",
      body: "The run completed.",
      tone: "success" as const,
    },
    failed: {
      title: "Run failed",
      body: "The run could not finish.",
      tone: "destructive" as const,
    },
    stuck: {
      title: "Run is stuck",
      body: "No progress has been reported.",
      tone: "warning" as const,
    },
  }[status];

  push({
    ...copy,
    action: {
      label: "Open run",
      href: `/bots/${encodeURIComponent(botId)}/threads/${encodeURIComponent(threadId)}?run=${encodeURIComponent(runId)}`,
    },
  });
}
