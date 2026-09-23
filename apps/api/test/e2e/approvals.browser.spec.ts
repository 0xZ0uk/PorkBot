import { expect, test } from "@playwright/test";
import {
  captureApprovalState,
  createBot,
  createHarness,
  guardOffline,
  newThreadFromRoster,
  press,
  sendMessage,
  signUp,
} from "./support.ts";
import type { BrowserHarness } from "./support.ts";

let harness: BrowserHarness | undefined;

test.beforeAll(async () => {
  harness = await createHarness({ suite: "api_browser_approvals" });
});

test.afterAll(async () => {
  await harness?.close();
  harness = undefined;
});

test.describe("the approval lane", () => {
  test("renders the gates and settles one through the queue", async ({ page }) => {
    const current = harness;

    if (current === undefined) {
      throw new Error("the browser harness did not start");
    }

    await guardOffline(page);
    await signUp(page, current.origin);
    // The actor and its repositories come from the browser's own session.
    await current.bindActor(page);
    await createBot(page, current.origin, {
      name: "Offline Helper",
      title: "Release fixture",
      description: "A deterministic browser bot",
      mission: "Answer using only the offline fixture.",
    });
    const threadId = await newThreadFromRoster(page, current.origin, "Offline Helper");

    await sendMessage(page, "Start offline task");
    // The run parks at its gate; a second gate is already past its deadline.
    await current.startRun(threadId);

    // The inline cards name the action, its target and the live deadline:
    // one gate waits, its twin is already past its deadline.
    const pendingCard = page.locator("[data-approval-state='pending']");
    const timedOutCard = page.locator("[data-approval-state='timed_out']");
    await expect(pendingCard).toHaveCount(1);
    await expect(timedOutCard).toHaveCount(1);
    await expect(pendingCard.locator("[data-approval-title]")).toHaveText("Approval needed", {
      ignoreCase: true,
    });
    await expect(timedOutCard.locator("[data-approval-title]")).toHaveText("Timed out", {
      ignoreCase: true,
    });
    await expect(pendingCard.locator("[data-approval-target]")).toHaveCount(1);
    await captureApprovalState(page, "approval-pending", { narrow: true });

    // The queue: waiting and history in one panel, the decision one press.
    await page.goto(`${current.origin}/approvals`);
    await expect(page.locator("#approvals-waiting")).toBeVisible();
    await expect(page.locator("#approvals-history")).toBeVisible();
    await expect(page.locator("[data-approval-state='pending']")).toHaveCount(1);
    await expect(page.locator("[data-approval-state='timed_out']")).toHaveCount(1);
    await captureApprovalState(page, "approvals-queue");

    await press(
      page.locator("[data-approval-state='pending']").getByRole("button", { name: "Approve" }),
    );
    await expect(page.locator("[data-approval-state='approved']")).toHaveCount(1);
    await expect(page.locator("#approvals-waiting [data-approval-state='pending']")).toHaveCount(0);
    await captureApprovalState(page, "approvals-history");
  });
});
