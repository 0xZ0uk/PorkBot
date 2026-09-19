// @vitest-environment jsdom
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
 * and a refusal is an alert with one retry.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: ThreadConsoleState = {
  threadId: "thread-1",
  status: "ready",
  entries: [
    { id: "message-0", role: "user", text: "do it", streaming: false },
    { id: "message-1", role: "assistant", text: "Hello", streaming: true },
  ],
  refusal: null,
  connection: "live",
};

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
