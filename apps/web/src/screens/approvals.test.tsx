// @vitest-environment jsdom
import type { Approval } from "@porkbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalsScreen } from "./approvals.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pending: Approval = {
  id: "approval-1",
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
  callId: "call-1",
  tool: "web_fetch",
  arguments: { url: "https://example.invalid", token: "[redacted]" },
  status: "pending",
  expiresAt: "2026-01-01T00:05:00.000Z",
  decidedBy: null,
  decidedAt: null,
  reason: null,
};

const timedOut: Approval = {
  ...pending,
  id: "approval-2",
  callId: "call-2",
  arguments: { path: "/tmp/report.txt" },
  status: "timed_out",
  decidedAt: "2026-01-01T00:05:01.000Z",
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

describe("the approvals screen", () => {
  it("shows the action, redacted arguments and transcript link, then records a vote", async () => {
    const onDecision = vi.fn().mockResolvedValue({
      ...pending,
      status: "denied",
      decidedBy: "user-1",
      decidedAt: "2026-01-01T00:01:00.000Z",
      reason: null,
    } satisfies Approval);

    await render(<ApprovalsScreen approvals={[pending]} bots={[]} onDecision={onDecision} />);

    expect(container.textContent).toContain("web_fetch");
    expect(container.textContent).toContain("https://example.invalid");
    expect(container.textContent).toContain("[redacted]");
    expect(container.querySelector("a[href='/threads/thread-1?run=run-1']")).not.toBeNull();

    const deny = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Deny",
    );

    await act(async () => {
      deny?.click();
    });

    expect(onDecision).toHaveBeenCalledWith({ runId: "run-1", callId: "call-1", vote: "deny" });
    expect(container.textContent).toContain("Denied");
  });

  it("filters history by status and keeps timed-out decisions visible", async () => {
    await render(
      <ApprovalsScreen approvals={[pending, timedOut]} bots={[]} onDecision={vi.fn()} />,
    );

    const status = container.querySelectorAll("select")[1];
    expect(status).toBeDefined();

    await act(async () => {
      if (status === undefined) {
        return;
      }

      status.value = "timed_out";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("Timed out");
    expect(container.textContent).not.toContain("https://example.invalid");
  });
});
