// @vitest-environment jsdom
import type { ToolCallSnapshot } from "@porkbot/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadConsoleState } from "../console.ts";
import { ThreadConsoleScreen } from "./thread-console.tsx";

/**
 * The console screen in a real DOM: the transcript renders each turn with its
 * role, the connection line appears only when the stream is not plainly live,
 * and a refusal is an alert with one retry. The tool-call timeline is the same
 * transcript: a call collapses to name, status and duration, expands to the
 * recorded arguments and result, links a truncated result to its artifact, and
 * marks a failure in the danger token with the reason it recorded.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: ThreadConsoleState = {
  threadId: "thread-1",
  status: "ready",
  entries: [
    { kind: "message", id: "message-0", role: "user", text: "do it", streaming: false },
    { kind: "message", id: "message-1", role: "assistant", text: "Hello", streaming: true },
  ],
  refusal: null,
  connection: "live",
  liveness: null,
};

function call(overrides: Partial<ToolCallSnapshot> = {}): ToolCallSnapshot {
  return { callId: "call-1", tool: "shell", arguments: {}, status: "requested", ...overrides };
}

function withCall(callSnapshot: ToolCallSnapshot): ThreadConsoleState {
  return {
    ...base,
    entries: [
      { kind: "message", id: "message-0", role: "user", text: "audit it", streaming: false },
      { kind: "tool", id: `tool:run-1:${callSnapshot.callId}`, runId: "run-1", call: callSnapshot },
      { kind: "message", id: "message-1", role: "assistant", text: "Done", streaming: false },
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
    await render(<ThreadConsoleScreen state={base} onRetry={vi.fn()} />);

    const items = [...container.querySelectorAll(".transcript > li")];

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.textContent)).toEqual(["Youdo it", "BotHello"]);
    expect(items[1]?.className).toContain("message-streaming");
  });

  it("shows connection state only when the stream is not live", async () => {
    const labels: Readonly<Record<string, string | null>> = {
      connecting: "Connecting…",
      reconnecting: "Reconnecting…",
      resumed: "Resumed",
      live: null,
    };

    for (const [connection, label] of Object.entries(labels)) {
      await render(
        <ThreadConsoleScreen
          state={{ ...base, connection: connection as ThreadConsoleState["connection"] }}
          onRetry={vi.fn()}
        />,
      );

      const status = container.querySelector("[role='status']");

      if (label === null) {
        expect(status, connection).toBeNull();
      } else {
        expect(status?.textContent, connection).toBe(label);
      }
    }
  });

  it("says a ready thread has no messages and stays quiet while loading", async () => {
    await render(<ThreadConsoleScreen state={{ ...base, entries: [] }} onRetry={vi.fn()} />);
    expect(container.textContent).toContain("No messages yet.");

    await render(
      <ThreadConsoleScreen state={{ ...base, entries: [], status: "loading" }} onRetry={vi.fn()} />,
    );
    expect(container.textContent).not.toContain("No messages yet.");
  });

  it("shows a refusal as an alert and offers one retry", async () => {
    const onRetry = vi.fn();

    await render(
      <ThreadConsoleScreen
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

    expect(link?.getAttribute("href")).toBe("/threads/thread-1/tool-results/run-1/call-1");
    expect(link?.textContent).toBe("Full result (4.0 KiB)");
    expect(container.textContent).toContain("[truncated]");
    expect(container.querySelector(".tool-call-duration")?.textContent).toBe("2.5 s");
  });

  it("offers a produced file by name when the result carries a download pointer", async () => {
    await render(
      <ThreadConsoleScreen
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
                id: "artifact-1",
                filename: "summary.md",
                contentType: "text/markdown",
                sizeBytes: 2_048,
                downloadPath: "/files/artifact-1",
              },
            },
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    const link = container.querySelector("a.tool-call-download");

    expect(link?.getAttribute("href")).toBe("/files/artifact-1");
    expect(link?.textContent).toBe("Download summary.md (2.0 KiB)");
  });

  it("renders no download link for a result whose artifact shape is broken", async () => {
    await render(
      <ThreadConsoleScreen
        state={withCall(
          call({
            status: "completed",
            result: {
              ok: true,
              artifact: { filename: "summary.md", downloadPath: "javascript:x" },
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

  it("answers a pending approval from the transcript with its run and call", async () => {
    const onApprovalDecision = vi.fn().mockResolvedValue(undefined);

    await render(
      <ThreadConsoleScreen
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
  });
});

describe("the console's liveness line", () => {
  it("names the step, the tool and the heartbeat lag while the run works", async () => {
    await render(
      <ThreadConsoleScreen
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
    await render(<ThreadConsoleScreen state={base} onRetry={vi.fn()} />);

    expect(container.querySelector("[data-liveness]")).toBeNull();
  });
});
