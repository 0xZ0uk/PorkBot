import { test } from "@playwright/test";
import { createHarness, guardOffline, signUp } from "./support.ts";
import type { BrowserHarness } from "./support.ts";

let harness: BrowserHarness | undefined;

test.beforeAll(async () => {
  harness = await createHarness({ suite: "api_browser_session" });
});

test.afterAll(async () => {
  await harness?.close();
  harness = undefined;
});

test.describe("the account lifecycle", () => {
  test("keeps the browser offline except the fixture's own origin", async ({ page }) => {
    const current = harness;

    if (current === undefined) {
      throw new Error("the browser harness did not start");
    }

    await guardOffline(page);
    // A request to anywhere but loopback is the proof: it aborts rather than
    // leaving, so a stray CDN font would show up here as a dead page.
    await page.goto(`${current.origin}/sign-up`);
    await page.waitForLoadState("networkidle");
  });

  test("creates the operator, signs out and signs back in", async ({ page }) => {
    const current = harness;

    if (current === undefined) {
      throw new Error("the browser harness did not start");
    }

    await guardOffline(page);
    await signUp(page, current.origin);
    // The actor and its repositories come from the browser's own session.
    await current.bindActor(page);
  });
});
