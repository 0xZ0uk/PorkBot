// @vitest-environment jsdom
import type { Approval } from "@porkbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalCard,
  approvalDeadlineLabel,
  describeApproval,
  liveApprovalStatus,
} from "./approval-card.tsx";

/**
 * The approval card in a real DOM: the sentence names the destination the
 * arguments carry, the deadline counts down from the durable instant and flips
 * to the timeout's denial when it passes, and the decision is two real buttons
 * that answer from the settled row before the stream catches up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (iso: string): number => Date.parse(iso);
const now = at("2026-01-01T00:00:00.000Z");

const pending: Approval = {
  id: "approval-1",
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
  callId: "call-1",
  tool: "web_fetch",
  arguments: { url: "https://example.invalid/page" },
  status: "pending",
  expiresAt: "2026-01-01T00:09:42.000Z",
  decidedBy: null,
  decidedAt: null,
  reason: null,
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

describe("the approval sentence", () => {
  it("names the URL and what leaving the machine means", () => {
    expect(describeApproval("web_fetch", { url: "https://example.invalid/page" })).toEqual({
      action: "web_fetch",
      target: "https://example.invalid/page",
      consequence: "Fetch https://example.invalid/page. The request leaves this machine.",
    });
  });

  it("names the path a file tool would touch", () => {
    expect(describeApproval("file_write", { path: "/srv/report.txt" })).toEqual({
      action: "file_write",
      target: "/srv/report.txt",
      consequence: "Read or write /srv/report.txt on the bot's computer.",
    });
  });

  it("binds a stored credential to its origin", () => {
    expect(
      describeApproval("request_secret", {
        name: "example_api",
        origin: "https://api.example.test",
      }).consequence,
    ).toBe('Use the stored credential "example_api" at https://api.example.test.');
  });

  it("names a command as the thing the bot would run", () => {
    expect(describeApproval("shell", { command: "rm -rf build" })).toEqual({
      action: "shell",
      target: "rm -rf build",
      consequence: "Run rm -rf build on the bot's computer.",
    });
  });

  it("uses the connector register's verbs for a tool that names no destination", () => {
    expect(describeApproval("send_email", {}).consequence).toBe(
      "Send through the send_email tool. This leaves the network and cannot be unsent.",
    );
    expect(describeApproval("delete_issue", {}).consequence).toBe(
      "Delete through the delete_issue tool. This cannot be undone.",
    );
    expect(describeApproval("read_page", {}).consequence).toBe("Run the read_page tool.");
  });
});

describe("the approval deadline", () => {
  it("counts in the largest two units that fit", () => {
    expect(approvalDeadlineLabel("2026-01-01T00:00:42.000Z", now)).toBe("42s left");
    expect(approvalDeadlineLabel("2026-01-01T00:09:42.000Z", now)).toBe("9m 42s left");
    expect(approvalDeadlineLabel("2026-01-01T02:14:00.000Z", now)).toBe("2h 14m left");
    expect(approvalDeadlineLabel("2026-01-02T04:00:00.000Z", now)).toBe("1d 4h left");
  });

  it("reads a passed, malformed or exact deadline as expired", () => {
    expect(approvalDeadlineLabel("2025-12-31T23:59:59.000Z", now)).toBe("Expired");
    expect(approvalDeadlineLabel("not-a-date", now)).toBe("Expired");
  });

  it("turns a pending gate whose deadline passed into the timeout's denial", () => {
    expect(liveApprovalStatus("pending", "2026-01-01T00:09:42.000Z", now)).toBe("pending");
    expect(liveApprovalStatus("pending", "2025-12-31T23:59:59.000Z", now)).toBe("timed_out");
    expect(liveApprovalStatus("approved", "2025-12-31T23:59:59.000Z", now)).toBe("approved");
  });
});

describe("the approval card", () => {
  it("shows the action, the target, the consequence and the live deadline", async () => {
    await render(<ApprovalCard {...pending} now={now} />);

    expect(container.querySelector(".approval-card-title")?.textContent).toContain(
      "Approval needed",
    );
    expect(container.querySelector(".approval-card-consequence")?.textContent).toBe(
      "Fetch https://example.invalid/page. The request leaves this machine.",
    );
    expect(container.querySelector(".approval-card-tool")?.textContent).toBe("web_fetch");
    expect(container.querySelector(".approval-card-target")?.textContent).toBe(
      "https://example.invalid/page",
    );
    expect(container.querySelector("time")?.textContent).toBe("9m 42s left");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(pending.expiresAt);
  });

  it("answers with two real buttons and settles from the row the vote returned", async () => {
    const onDecide = vi.fn().mockResolvedValue({
      ...pending,
      status: "denied",
      decidedBy: "user-1",
      decidedAt: "2026-01-01T00:01:00.000Z",
      reason: "not this address",
    } satisfies Approval);

    await render(<ApprovalCard {...pending} now={now} onDecide={onDecide} />);

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Approve", "Deny"]);
    expect(buttons.every((button) => button.type === "button")).toBe(true);

    const deny = buttons.find((button) => button.textContent === "Deny");

    await act(async () => {
      deny?.click();
    });

    expect(onDecide).toHaveBeenCalledWith("deny");
    expect(container.querySelector(".approval-card-title")?.textContent).toContain("Denied");
    expect(container.querySelector(".approval-card-decision")?.textContent).toBe(
      "not this address",
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the gate and the vote when the record fails", async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error("offline"));

    await render(<ApprovalCard {...pending} now={now} onDecide={onDecide} />);

    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve",
    );

    await act(async () => {
      approve?.click();
    });

    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "The decision could not be recorded. Try again.",
    );
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  it("turns a gate whose deadline passes while it waits into a visible denial", async () => {
    await render(
      <ApprovalCard {...pending} expiresAt="2026-01-01T00:00:02.000Z" onDecide={vi.fn()} />,
    );

    expect(container.querySelector("time")?.textContent).toBe("2s left");

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });

    expect(
      container.querySelector("[data-approval-state]")?.getAttribute("data-approval-state"),
    ).toBe("timed_out");
    expect(container.querySelector(".approval-card-title")?.textContent).toContain("Timed out");
    expect(container.querySelector(".approval-card-decision")?.textContent).toBe(
      "The deadline passed, so the run was denied.",
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
