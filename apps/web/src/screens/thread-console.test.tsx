// @vitest-environment jsdom
import type { Approval } from "@porkbot/contracts";
import type { ToolCallSnapshot } from "@porkbot/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBot } from "../../test/fakes.ts";
import type { ThreadConsoleState, TranscriptMessageEntry } from "../console.ts";
import { ThreadConsoleScreen, groupTranscriptSessions, sessionLabel } from "./thread-console.tsx";

/**
 * The console screen in a real DOM: the transcript renders each turn as a
 * bubble with its speaker — the operator's word present but not painted, the
 * bot's named beside its mascot — and opens each session with a timestamp
 * separator. The connection appears only when the stream is not plainly live,
 * as a chip; a refusal is an alert with one retry; and the transcript follows
 * a streaming run while the reader is at the bottom and offers a jump back
 * once they scroll away. The tool-call timeline is the same transcript: a call
 * collapses to name, status and duration, expands to the recorded arguments
 * and result, links a truncated result to its artifact, and marks a failure in
 * the danger token with the reason it recorded.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: ThreadConsoleState = {
  threadId: "thread-1",
  status: "ready",
  entries: [
    {
      kind: "message",
      id: "message-0",
      role: "user",
      text: "do it",
      createdAt: "2026-01-01T09:00:00.000Z",
      attachments: [],
      streaming: false,
    },
    {
      kind: "message",
      id: "message-1",
      role: "assistant",
      text: "Hello",
      createdAt: "2026-01-01T09:01:00.000Z",
      attachments: [],
      streaming: true,
    },
  ],
  refusal: null,
  connection: "live",
  liveness: null,
  activeRunId: null,
  stopping: false,
  stopError: null,
};

function call(overrides: Partial<ToolCallSnapshot> = {}): ToolCallSnapshot {
  return { callId: "call-1", tool: "shell", arguments: {}, status: "requested", ...overrides };
}

function withCall(callSnapshot: ToolCallSnapshot): ThreadConsoleState {
  return {
    ...base,
    entries: [
      {
        kind: "message",
        id: "message-0",
        role: "user",
        text: "audit it",
        createdAt: "2026-01-01T09:00:00.000Z",
        attachments: [],
        streaming: false,
      },
      { kind: "tool", id: `tool:run-1:${callSnapshot.callId}`, runId: "run-1", call: callSnapshot },
      {
        kind: "message",
        id: "message-1",
        role: "assistant",
        text: "Done",
        createdAt: "2026-01-01T09:01:00.000Z",
        attachments: [],
        streaming: false,
      },
    ],
  };
}

function withAttachment(): ThreadConsoleState {
  return {
    ...base,
    entries: [
      {
        kind: "message",
        id: "message-0",
        role: "assistant",
        text: "Here it is",
        createdAt: "2026-01-01T09:00:00.000Z",
        attachments: [
          {
            type: "file",
            attachmentId: "attachment-1",
            filename: "notes.txt",
            contentType: "text/plain",
            sizeBytes: 2_048,
          },
        ],
        streaming: false,
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

describe("the thread console screen", () => {
  it("renders every turn with its role and its text", async () => {
    await render(<ThreadConsoleScreen botId="bot-1" state={base} onRetry={vi.fn()} />);

    const items = [...container.querySelectorAll(".transcript > li")];

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.textContent)).toEqual(["Youdo it", "BotHello"]);
    expect(items[1]?.className).toContain("message-streaming");
  });

  it("uses the bot identity in the assistant attribution", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={base}
        bot={fakeBot("bot-1", "Ada")}
        avatarUrl="data:image/png;base64,ZmFrZQ=="
        onRetry={vi.fn()}
      />,
    );

    // The shell header owns the thread's identity now, so the pane repeats no
    // header: the bot is named where it speaks.
    expect(container.querySelector(".thread-header")).toBeNull();
    expect(container.querySelectorAll(".message-attribution .pb-avatar")).toHaveLength(1);
    expect(container.querySelectorAll('.pb-avatar img[alt=""]')).toHaveLength(1);
    expect(container.textContent).toContain("AdaHello");
  });

  it("gives the operator and the bot distinct bubbles instead of bare prose", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={base}
        bot={fakeBot("bot-1", "Ada")}
        onRetry={vi.fn()}
      />,
    );

    const operator = container.querySelector(".message-user");
    const bot = container.querySelector(".message-bot");

    expect(operator).not.toBeNull();
    expect(bot).not.toBeNull();
    expect(operator?.querySelector(".message-bubble")).not.toBeNull();
    expect(bot?.querySelector(".message-bubble")).not.toBeNull();
    // The operator's word is present for a screen reader, not painted: the
    // alignment and the fill are what a reader sees.
    expect(operator?.querySelector(".message-attribution.sr-only")?.textContent).toBe("You");
  });

  it("opens a session with a timestamp separator", async () => {
    await render(<ThreadConsoleScreen botId="bot-1" state={base} onRetry={vi.fn()} />);

    const separator = container.querySelector(".transcript-separator");

    expect(separator?.textContent).toBe(sessionLabel("2026-01-01T09:00:00.000Z", new Date()));
    expect(separator?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-01-01T09:00:00.000Z",
    );
  });

  it("renders an attachment as a card with its name, size and open action", async () => {
    await render(<ThreadConsoleScreen botId="bot-1" state={withAttachment()} onRetry={vi.fn()} />);

    const card = container.querySelector(".attachment-card");
    const open = card?.querySelector("a.message-attachment");

    expect(card?.className).toContain("pb-card");
    expect(open?.getAttribute("href")).toBe("/files/attachment-1");
    expect(card?.textContent).toContain("notes.txt");
    expect(card?.textContent).toContain("text/plain · 2.0 KiB");
    expect(card?.textContent).toContain("Open");
  });

  it("shows connection state as a chip only when the stream is not live", async () => {
    const labels: Readonly<Record<string, string | null>> = {
      connecting: "Connecting…",
      reconnecting: "Reconnecting…",
      resumed: "Resumed",
      live: null,
    };

    for (const [connection, label] of Object.entries(labels)) {
      await render(
        <ThreadConsoleScreen
          botId="bot-1"
          state={{ ...base, connection: connection as ThreadConsoleState["connection"] }}
          onRetry={vi.fn()}
        />,
      );

      const status = container.querySelector("[role='status']");

      if (label === null) {
        expect(status, connection).toBeNull();
      } else {
        expect(status?.textContent, connection).toBe(label);
        expect(status?.querySelector(".pb-badge"), connection).not.toBeNull();
      }
    }
  });

  it("says a ready thread has no messages and stays quiet while loading", async () => {
    await render(
      <ThreadConsoleScreen botId="bot-1" state={{ ...base, entries: [] }} onRetry={vi.fn()} />,
    );
    expect(container.textContent).toContain("No messages yet.");

    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={{ ...base, entries: [], status: "loading" }}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain("No messages yet.");
  });

  it("shows a refusal as an alert and offers one retry", async () => {
    const onRetry = vi.fn();

    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={{ ...base, status: "refused", refusal: "This thread is not available." }}
        onRetry={onRetry}
      />,
    );

    const alert = container.querySelector("[role='alert']");

    expect(alert?.textContent).toBe("This thread is not available.");

    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );

    expect(retry).toBeDefined();

    await act(async () => {
      retry?.click();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("the tool-call timeline", () => {
  it("collapses a call to name, status and duration, and expands to its arguments and result", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={withCall(
          call({
            status: "completed",
            arguments: { command: "ls", apiKey: "[redacted]" },
            result: { stdout: "report.txt" },
            durationMs: 120,
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    const item = container.querySelector(".tool-call");

    expect(item).not.toBeNull();
    expect(item?.querySelector(".tool-call-name")?.textContent).toBe("shell");
    expect(item?.querySelector(".tool-call-status")?.textContent).toBe("Completed");
    expect(item?.querySelector(".tool-call-duration")?.textContent).toBe("120 ms");
    expect(item?.className).not.toContain("tool-call-failed");

    const details = container.querySelector("details.tool-call-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);

    await act(async () => {
      container
        .querySelector("summary.tool-call-summary")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(details.open).toBe(true);

    const json = [...container.querySelectorAll(".tool-call-json")].map((node) => node.textContent);

    // The arguments are the recorded value verbatim: the placeholder the
    // recorder stored is what a reader sees, never the secret behind it.
    expect(json[0]).toContain('"command": "ls"');
    expect(json[0]).toContain("[redacted]");
    expect(json[0]).not.toContain("sk-live");
    expect(json[1]).toContain('"stdout": "report.txt"');
  });

  it("links a truncated result to its artifact instead of stopping at the preview", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={withCall(
          call({
            status: "completed",
            result: "x".repeat(64) + " [truncated]",
            resultArtifact: { kind: "tool_call", callId: "call-1", bytes: 4_096 },
            durationMs: 2_500,
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    const link = container.querySelector("a.tool-call-artifact");

    expect(link?.getAttribute("href")).toBe(
      "/bots/bot-1/threads/thread-1/tool-results/run-1/call-1",
    );
    expect(link?.textContent).toBe("Full result (4.0 KiB)");
    expect(container.textContent).toContain("[truncated]");
    expect(container.querySelector(".tool-call-duration")?.textContent).toBe("2.5 s");
  });

  it("offers a produced file by name, rebuilding the link from the artifact id", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={withCall(
          call({
            callId: "call-file",
            tool: "file_write",
            status: "completed",
            result: {
              ok: true,
              path: "reports/summary.md",
              bytes: 2_048,
              artifact: {
                id: "01900000-0000-7000-8000-00000000a1f0",
                filename: "summary.md",
                contentType: "text/markdown",
                sizeBytes: 2_048,
                // Untrusted tool output: the row must ignore this and derive
                // the path from the id, so a hostile value cannot render.
                downloadPath: "//evil.example/phish",
              },
            },
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    const link = container.querySelector("a.tool-call-download");

    expect(link?.getAttribute("href")).toBe("/files/01900000-0000-7000-8000-00000000a1f0");
    expect(link?.textContent).toBe("Download summary.md (2.0 KiB)");
  });

  it("renders no download link for a result whose artifact shape is broken", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={withCall(
          call({
            status: "completed",
            result: {
              ok: true,
              artifact: {
                id: "not-a-uuid",
                filename: "summary.md",
                sizeBytes: 2_048,
                downloadPath: "/files/not-a-uuid",
              },
            },
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    expect(container.querySelector("a.tool-call-download")).toBeNull();
  });

  it("marks a failure in the danger token and shows the typed reason", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={withCall(
          call({
            callId: "call-2",
            tool: "rm",
            status: "failed",
            error: 'tool "rm" failed (timed_out): no answer before the deadline',
            durationMs: 30_000,
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    const item = container.querySelector(".tool-call");

    expect(item?.className).toContain("tool-call-failed");
    expect(item?.querySelector(".tool-call-status")?.textContent).toBe("Failed");
    expect(container.querySelector(".tool-call-error")?.textContent).toBe(
      'tool "rm" failed (timed_out): no answer before the deadline',
    );
  });

  it("says a call is waiting for approval rather than calling it running", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={withCall(
          call({
            approval: { status: "pending", expiresAt: "2026-01-01T00:05:00.000Z" },
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    expect(container.querySelector(".tool-call-status")?.textContent).toBe("Waiting for approval");
  });

  it("renders the approval card with its consequence and live deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    try {
      await render(
        <ThreadConsoleScreen
          botId="bot-1"
          state={withCall(
            call({
              tool: "web_fetch",
              arguments: { url: "https://example.invalid" },
              approval: { status: "pending", expiresAt: "2026-01-01T00:05:00.000Z" },
            }),
          )}
          onRetry={vi.fn()}
        />,
      );

      const card = container.querySelector(".approval-card");

      expect(card?.getAttribute("data-approval-state")).toBe("pending");
      expect(card?.textContent).toContain("Approval needed");
      expect(card?.textContent).toContain(
        "Fetch https://example.invalid. The request leaves this machine.",
      );
      expect(card?.querySelector("time")?.textContent).toBe("5m left");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a pending approval from the transcript with its run and call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const onApprovalDecision = vi.fn().mockResolvedValue({
      id: "approval-1",
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      callId: "call-1",
      tool: "shell",
      arguments: {},
      status: "approved",
      expiresAt: "2026-01-01T00:05:00.000Z",
      decidedBy: "user-1",
      decidedAt: "2026-01-01T00:00:30.000Z",
      reason: null,
    } satisfies Approval);

    try {
      await render(
        <ThreadConsoleScreen
          botId="bot-1"
          state={withCall(
            call({ approval: { status: "pending", expiresAt: "2026-01-01T00:05:00.000Z" } }),
          )}
          onRetry={vi.fn()}
          onApprovalDecision={onApprovalDecision}
        />,
      );

      const approve = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Approve",
      );

      await act(async () => {
        approve?.click();
      });

      expect(onApprovalDecision).toHaveBeenCalledWith({
        runId: "run-1",
        callId: "call-1",
        vote: "approve",
      });
      expect(container.querySelector(".approval-card")?.getAttribute("data-approval-state")).toBe(
        "approved",
      );
      expect(container.querySelectorAll(".approval-card button")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a timed-out gate visible as a denial beside the collapsed call", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={withCall(
          call({
            status: "failed",
            error: 'tool "web_fetch" failed (timed_out): the approval timed out',
            approval: { status: "timed_out", expiresAt: "2025-12-31T23:55:00.000Z" },
          }),
        )}
        onRetry={vi.fn()}
        onApprovalDecision={vi.fn()}
      />,
    );

    const card = container.querySelector(".approval-card");

    expect(card?.getAttribute("data-approval-state")).toBe("timed_out");
    expect(card?.textContent).toContain("Timed out");
    expect(card?.textContent).toContain("The deadline passed, so the run was denied.");
    expect(container.querySelector("details.tool-call-details")?.hasAttribute("open")).toBe(false);
    expect(card?.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("the console's liveness line", () => {
  it("names the step, the tool and the heartbeat lag while the run works", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={{
          ...base,
          liveness: {
            state: "working",
            tool: "shell",
            heartbeatLagMs: 3_000,
            sinceProgressMs: 10_000,
          },
        }}
        onRetry={vi.fn()}
      />,
    );

    expect(container.querySelector("[data-liveness='working']")?.textContent).toBe(
      "Running shell… · heartbeat 3s ago",
    );
  });

  it("marks a stuck run with its silence, not as healthy", async () => {
    await render(
      <ThreadConsoleScreen
        botId="bot-1"
        state={{
          ...base,
          liveness: {
            state: "stuck",
            tool: "shell",
            heartbeatLagMs: 62_000,
            sinceProgressMs: 185_000,
          },
        }}
        onRetry={vi.fn()}
      />,
    );

    const line = container.querySelector("[data-liveness='stuck']");

    expect(line?.textContent).toBe("Stuck — no progress for 3m 5s · heartbeat 1m 2s ago");
    expect(line?.className).toContain("console-liveness-stuck");
  });

  it("shows no liveness chrome when no run is active", async () => {
    await render(<ThreadConsoleScreen botId="bot-1" state={base} onRetry={vi.fn()} />);

    expect(container.querySelector("[data-liveness]")).toBeNull();
  });
});

describe("the transcript's sessions", () => {
  function message(id: string, createdAt: string | null): TranscriptMessageEntry {
    return {
      kind: "message",
      id,
      role: "assistant",
      text: id,
      createdAt,
      attachments: [],
      streaming: false,
    };
  }

  it("groups turns within five minutes and separates a longer gap", () => {
    const sessions = groupTranscriptSessions(
      [
        message("a", new Date(2026, 0, 1, 9, 0).toISOString()),
        message("b", new Date(2026, 0, 1, 9, 4).toISOString()),
        message("c", new Date(2026, 0, 1, 9, 10).toISOString()),
      ],
      new Date(2026, 0, 1, 12, 0),
    );

    expect(sessions.map((session) => session.entries.length)).toEqual([2, 1]);
    expect(sessions[0]?.label).toBe("Today · 09:00");
    expect(sessions[1]?.label).toBe("Today · 09:10");
  });

  it("lets a turn only the stream knows inherit the session beside it", () => {
    const sessions = groupTranscriptSessions(
      [message("live", null), message("persisted", new Date(2026, 0, 1, 9, 0).toISOString())],
      new Date(2026, 0, 1, 12, 0),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.label).toBeNull();
    expect(sessions[0]?.entries).toHaveLength(2);
  });

  it("names yesterday and an older day for a session that is not today", () => {
    const now = new Date(2026, 0, 2, 12, 0);

    expect(sessionLabel(new Date(2026, 0, 1, 9, 0).toISOString(), now)).toBe("Yesterday · 09:00");
    expect(sessionLabel(new Date(2025, 11, 30, 9, 0).toISOString(), now)).toBe("30 Dec · 09:00");
  });
});

describe("the transcript anchor", () => {
  function scroller(): HTMLDivElement {
    const element = container.querySelector(".transcript-scroll");

    expect(element).not.toBeNull();
    return element as HTMLDivElement;
  }

  function setMetrics(element: HTMLDivElement, scrollTop: number): void {
    Object.defineProperty(element, "scrollHeight", { value: 1_000, configurable: true });
    Object.defineProperty(element, "clientHeight", { value: 100, configurable: true });
    element.scrollTop = scrollTop;
  }

  async function scroll(element: HTMLDivElement): Promise<void> {
    await act(async () => {
      element.dispatchEvent(new Event("scroll"));
    });
  }

  function jumpButton(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Jump to latest",
    );
  }

  function extended(): ThreadConsoleState {
    return {
      ...base,
      entries: [
        ...base.entries,
        {
          kind: "message",
          id: "message-2",
          role: "assistant",
          text: " more",
          createdAt: "2026-01-01T09:01:30.000Z",
          attachments: [],
          streaming: true,
        },
      ],
    };
  }

  it("follows new turns while the reader is at the bottom", async () => {
    await render(<ThreadConsoleScreen botId="bot-1" state={base} onRetry={vi.fn()} />);

    const element = scroller();

    setMetrics(element, 1_000);
    await scroll(element);

    expect(container.querySelector(".transcript-jump")).toBeNull();

    await render(<ThreadConsoleScreen botId="bot-1" state={extended()} onRetry={vi.fn()} />);

    expect(element.scrollTop).toBe(1_000);
  });

  it("leaves a scrolled-away reader in place and offers the jump back", async () => {
    await render(<ThreadConsoleScreen botId="bot-1" state={base} onRetry={vi.fn()} />);

    const element = scroller();

    setMetrics(element, 0);
    await scroll(element);

    expect(jumpButton()).toBeDefined();

    await render(<ThreadConsoleScreen botId="bot-1" state={extended()} onRetry={vi.fn()} />);

    // A token arriving must not yank someone who is reading earlier turns.
    expect(element.scrollTop).toBe(0);
    expect(jumpButton()).toBeDefined();

    await act(async () => {
      jumpButton()?.click();
    });

    expect(element.scrollTop).toBe(1_000);
    expect(jumpButton()).toBeUndefined();
  });
});
