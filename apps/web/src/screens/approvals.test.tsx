// @vitest-environment jsdom
import type { Approval } from "@porkbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBot } from "../../test/fakes.ts";
import { ApprovalsScreen } from "./approvals.tsx";

/**
 * The approval queue in a real DOM: pending gates come first as the same card
 * the transcript renders, history follows with the same card in its resolved
 * state, and the buckets follow the deadline — a pending row whose deadline
 * has passed is history already, because the store refuses a vote after it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.parse("2026-01-01T00:00:00.000Z");

const bot = fakeBot("bot-1", "Ledger");

const pending: Approval = {
  id: "approval-1",
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
  callId: "call-1",
  tool: "web_fetch",
  arguments: { url: "https://example.invalid", token: "[redacted]" },
  status: "pending",
  expiresAt: "2026-01-01T00:09:42.000Z",
  decidedBy: null,
  decidedAt: null,
  reason: null,
};

const timedOut: Approval = {
  ...pending,
  id: "approval-2",
  callId: "call-2",
  tool: "file_write",
  arguments: { path: "/srv/report.txt" },
  status: "timed_out",
  decidedAt: "2025-12-31T23:50:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function cards(): Element[] {
  return [...container.querySelectorAll("[data-approval-state]")];
}

describe("the approvals queue", () => {
  it("puts waiting gates first and settles the card from the vote it records", async () => {
    const onDecision = vi.fn().mockResolvedValue({
      ...pending,
      status: "approved",
      decidedBy: "user-1",
      decidedAt: "2026-01-01T00:01:00.000Z",
    } satisfies Approval);

    await render(
      <ApprovalsScreen approvals={[timedOut, pending]} bots={[bot]} onDecision={onDecision} />,
    );

    const waiting = container.querySelector("#approvals-waiting");

    expect(waiting?.textContent).toContain("Waiting for you");
    expect(waiting?.nextElementSibling?.querySelector("[data-approval-state]")?.textContent).toContain(
      "Approval needed",
    );
    expect(container.textContent).toContain(
      "Fetch https://example.invalid. The request leaves this machine.",
    );
    expect(container.textContent).toContain("9m 42s left");
    expect(
      container.querySelector("a[href='/bots/bot-1/threads/thread-1?run=run-1']"),
    ).not.toBeNull();
    // The queue is the audit surface: the redacted payload is one disclosure
    // away rather than in the transcript's face.
    expect(container.textContent).toContain("[redacted]");

    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );

    await act(async () => {
      approve?.click();
    });

    expect(onDecision).toHaveBeenCalledWith({ runId: "run-1", callId: "call-1", vote: "approve" });
    expect(container.querySelector("#approvals-waiting")).toBeNull();
    expect(container.textContent).toContain("Approved");
    expect(container.querySelector("[data-approval-state='approved']")).not.toBeNull();
  });

  it("keeps history filterable and shows a timed-out gate as a denial", async () => {
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
    expect(container.textContent).toContain("The deadline passed, so the run was denied.");
    expect(container.textContent).not.toContain("https://example.invalid");
    expect(container.querySelector("[data-approval-state='timed_out']")).not.toBeNull();
  });

  it("moves a gate whose deadline passes into history as a denial", async () => {
    await render(
      <ApprovalsScreen
        approvals={[{ ...pending, expiresAt: "2026-01-01T00:00:02.000Z" }]}
        bots={[]}
        onDecision={vi.fn()}
      />,
    );

    expect(container.querySelector("#approvals-waiting")).not.toBeNull();
    expect(container.textContent).toContain("2s left");

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });

    expect(container.querySelector("#approvals-waiting")).toBeNull();
    expect(container.textContent).toContain("Timed out");
    expect(container.querySelector("[data-approval-state='timed_out']")).not.toBeNull();
  });

  it("shows the same card in both surfaces: consequence, target and deadline", async () => {
    await render(<ApprovalsScreen approvals={[pending]} bots={[bot]} onDecision={vi.fn()} />);

    const card = cards()[0];

    expect(card?.getAttribute("data-approval-state")).toBe("pending");
    expect(card?.querySelector("[data-approval-tool]")?.textContent).toBe("web_fetch");
    expect(card?.querySelector("[data-approval-target]")?.textContent).toBe(
      "https://example.invalid",
    );
    expect(card?.querySelector("time")?.textContent).toBe("9m 42s left");
    expect(card?.querySelector(".approval-card-bot")?.textContent).toContain("Ledger");
    expect(card?.querySelector(".approval-card-run")?.textContent).toBe("Run run-1");
    expect(card?.querySelectorAll("button")).toHaveLength(2);
  });
});
