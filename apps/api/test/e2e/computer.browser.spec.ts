import { expect, test } from "@playwright/test";
import {
  captureComputer,
  createBot,
  createHarness,
  guardOffline,
  press,
  signUp,
} from "./support.ts";
import type { BrowserHarness } from "./support.ts";

let harness: BrowserHarness | undefined;

test.beforeAll(async () => {
  harness = await createHarness({ suite: "api_browser_computer" });
});

test.afterAll(async () => {
  await harness?.close();
  harness = undefined;
});

test.describe("the computer lane", () => {
  test("starts, inspects and stops the machine through the wire", async ({ page }) => {
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
    await current.attachComputer(botId);

    await page.goto(`${current.origin}/bots/${botId}/computer`);
    // The surface states the machine's state as a word before any action.
    await expect(page.locator("[data-computer-view-state]")).toHaveText("Gone", {
      ignoreCase: true,
    });

    // The lifecycle menu opens from the machine-actions control.
    await press(page.getByRole("button", { name: /machine actions/ }));
    await press(page.getByRole("menuitem", { name: "Start — bring the machine up" }));
    await expect(page.locator("[data-computer-view-state]")).toHaveText("Running", {
      ignoreCase: true,
    });
    await expect(page.locator("[data-computer-frame]")).toBeVisible();

    // The captures walk the whole lifecycle: the verbs, the destructive
    // confirm and the provider sheet that says what switching moves.
    await captureComputer(page);

    // The terminal: one command in, the machine's words out.
    await press(page.getByRole("tab", { name: "Terminal" }));
    await page.getByLabel("Command", { exact: true }).fill("echo hello");
    await press(page.getByRole("button", { name: "Run", exact: true }));
    await expect(page.locator("[data-terminal-stdout]")).toContainText("hello");

    // The stop, and the surface settles at Stopped.
    await press(page.getByRole("button", { name: /machine actions/ }));
    await press(page.getByRole("menuitem", { name: "Stop — park it, keeping the home" }));
    await expect(page.locator("[data-computer-view-state]")).toHaveText("Stopped", {
      ignoreCase: true,
    });
  });
});
