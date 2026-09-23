import { test } from "@playwright/test";
import { captureMemory, createHarness, createBot, guardOffline, press, signUp } from "./support.ts";
import type { BrowserHarness } from "./support.ts";
import { expect } from "@playwright/test";

let harness: BrowserHarness | undefined;

test.beforeAll(async () => {
  harness = await createHarness({ suite: "api_browser_memory" });
});

test.afterAll(async () => {
  await harness?.close();
  harness = undefined;
});

test.describe("the memory lane", () => {
  test("edits, removes and restores a document through the wire", async ({ page }) => {
    const current = harness;

    if (current === undefined) {
      throw new Error("the browser harness did not start");
    }

    await guardOffline(page);
    await signUp(page, current.origin);
    // The actor and its repositories come from the browser's own session.
    await current.bindActor(page);
    const botId = await createBot(page, current.origin, {
      name: "Offline Helper",
      title: "Release fixture",
      description: "A deterministic browser bot",
      mission: "Answer using only the offline fixture.",
    });
    await current.seedMemory(botId);

    await page.goto(`${current.origin}/bots/${botId}/memory`);
    const memoryCard = page.locator("[data-memory-document]").first();
    await expect(memoryCard.getByRole("heading", { name: "Release note" })).toBeVisible();

    // The history capture (slice 13.12): the card with its revision timeline open.
    await captureMemory(page, "memory-history", { history: true });

    // The edit: one title, one body, one reason.
    await press(memoryCard.getByRole("button", { name: "Edit" }));
    const memoryForm = memoryCard.locator("[data-memory-form]");
    await memoryForm.getByLabel("Title", { exact: true }).fill("Release note updated");
    await memoryForm.locator("textarea").fill("The browser fixture still starts offline.");
    await memoryForm.locator("input").nth(1).fill("Verify memory editing");
    await press(memoryForm.getByRole("button", { name: "Save" }));
    await expect(memoryCard.getByRole("heading", { name: "Release note updated" })).toBeVisible();

    // The remove, behind its own confirmation that names what is lost.
    await press(memoryCard.getByRole("button", { name: "Remove" }));
    const removeForm = memoryCard.locator("[data-memory-form]");
    await removeForm.locator("input").fill("Superseded by the fixture note");
    await press(removeForm.getByRole("button", { name: "Remove document" }));
    await expect(page.getByText("Nothing remembered yet")).toBeVisible();

    // The tombstone in the Removed scope.
    await press(page.getByRole("radio", { name: "Removed", exact: true }));
    await expect(page.locator("[data-removed]")).toBeVisible();
    await captureMemory(page, "memory-removed");

    // The restore, and the lane returns to Current with the document back.
    const tombstone = page.locator("[data-removed]");
    await press(tombstone.getByRole("button", { name: "Restore", exact: true }));
    const restoreForm = tombstone.locator("[data-memory-form]");
    await press(restoreForm.getByRole("button", { name: "Restore revision" }));
    await expect(page.getByText("Nothing removed", { exact: true })).toBeVisible();
    await press(page.getByRole("radio", { name: "Current", exact: true }));
    await expect(memoryCard.getByRole("heading", { name: "Release note updated" })).toBeVisible();
  });
});
