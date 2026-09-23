import { expect, test } from "@playwright/test";
import {
  captureApprovalState,
  captureConsoleState,
  captureUsage,
  captureWorkspace,
  createBot,
  createHarness,
  guardOffline,
  newThreadFromRoster,
  press,
  sendMessage,
  signUp,
  rpc,
} from "./support.ts";
import type { BrowserHarness } from "./support.ts";
import { uiHooks } from "@porkbot/testkit";

let harness: BrowserHarness | undefined;

test.beforeAll(async () => {
  harness = await createHarness({ suite: "api_browser_console" });
});

test.afterAll(async () => {
  await harness?.close();
  harness = undefined;
});

test.describe("the console lane", () => {
  test("streams a run, settles its gates and reports the ledger", async ({ page }) => {
    const current = harness;

    if (current === undefined) {
      throw new Error("the browser harness did not start");
    }

    await guardOffline(page);
    await signUp(page, current.origin);
    // The actor and its repositories come from the browser's own session.
    const repositories = await current.bindActor(page);
    const botId = await createBot(page, current.origin, {
      name: "Offline Helper",
      title: "Release fixture",
      description: "A deterministic browser bot",
      mission: "Answer using only the offline fixture.",
    });
    const threadId = await newThreadFromRoster(page, current.origin, "Offline Helper");

    await sendMessage(page, "Start offline task");
    const run = await current.startRun(threadId);
    await current.seedUsage(botId);

    // The tool appears in the timeline before its answer does.
    await expect(page.locator(uiHooks.toolCallName, { hasText: "shell" })).toBeVisible();
    await expect(page.getByText(/Waiting for approval: shell/)).toBeVisible();

    // The steer message is the operator's hand on a live run.
    await sendMessage(page, "Steer this run");
    await expect(page.getByText("Steer this run", { exact: true })).toBeVisible();
    await run.continueAfterApproval();

    // The tokens stream in and the resolved card stays in place beside them.
    await expect(page.getByText(/offline assistant response/)).toBeVisible();
    await expect(page.locator(uiHooks.approvalStateApproved)).toHaveCount(1);
    await expect(page.locator(uiHooks.approvalStateTimedOut)).toHaveCount(1);
    await captureApprovalState(page, "approval-resolved");
    await captureConsoleState(page, "conversation-streaming");

    // The stop: the operator ends it, the wire confirms, the surface settles.
    await rpc(page, "runs/stop", { runId: run.runId });
    await run.cancel();
    await expect(page.getByText(/offline assistant response/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/offline assistant response/)).toBeVisible();
    await expect(page.locator(uiHooks.toolCallName, { hasText: "shell" })).toBeVisible();

    // An attachment: staged, uploaded and sent, then read back on its card.
    await page
      .locator(uiHooks.composerFileInput)
      .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("offline") });
    await sendMessage(page, "Here is the note");
    await expect(page.locator(uiHooks.messageAttachment)).toBeVisible();
    await captureConsoleState(page, "conversation-attachment");

    // A failed upload stays on its row and the draft stays unsent.
    const uploadRoute = /\/threads\/[^/]+\/attachments/;
    await page.route(uploadRoute, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"offline"}' }),
    );
    await page
      .locator(uiHooks.composerFileInput)
      .setInputFiles({ name: "lost.txt", mimeType: "text/plain", buffer: Buffer.from("lost") });
    await expect(page.locator(uiHooks.composerFileFailed)).toBeVisible();
    await captureConsoleState(page, "conversation-upload-failed");
    await page.unroute(uploadRoute);
    // A failed row keeps the draft unsent until it is cleared.
    await press(page.getByRole("button", { name: "Remove lost.txt" }));

    // A run that completes: its card closes the run's steps with the outcome.
    const completing = await current.startRun(threadId, { stop: "working" });
    await expect(page.locator(uiHooks.liveStripStep, { hasText: "Running shell" })).toBeVisible();
    await captureConsoleState(page, "run-surface-running");
    await completing.complete();
    await expect(page.locator(uiHooks.runCardTitle).last()).toHaveText("Run finished", {
      ignoreCase: true,
    });
    await captureConsoleState(page, "run-surface-completed");

    // And one that fails names its typed reason on the same card.
    await sendMessage(page, "Fail the offline task");
    const failing = await current.startRun(threadId, { stop: "working" });
    await expect(page.locator(uiHooks.liveStripStep, { hasText: "Running shell" })).toBeVisible();
    failing.fail();
    await expect(page.locator(uiHooks.runCardTitle).last()).toHaveText("Run failed", {
      ignoreCase: true,
    });
    await captureConsoleState(page, "run-surface-failed");

    // The shell's captures and the usage ledger close the flow.
    await captureWorkspace(page, current.origin, botId, threadId);
    await captureUsage(page, current.origin, botId);
    void repositories;
  });
});
