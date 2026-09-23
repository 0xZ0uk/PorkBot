import { expect, test } from "@playwright/test";
import {
  captureSettings,
  createBot,
  createHarness,
  guardOffline,
  press,
  rpc,
  signUp,
} from "./support.ts";
import type { BrowserHarness } from "./support.ts";

let harness: BrowserHarness | undefined;

test.beforeAll(async () => {
  harness = await createHarness({ suite: "api_browser_connections" });
});

test.afterAll(async () => {
  await harness?.close();
  harness = undefined;
});

test.describe("the connections lane", () => {
  test("connects a model endpoint and keeps it in settings", async ({ page }) => {
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

    await page.goto(`${current.origin}/settings`);
    await expect(page.locator("#models")).toBeVisible();
    await press(page.getByRole("button", { name: "New connection" }));

    await page.getByLabel("Label", { exact: true }).fill("Offline model");
    await page.getByLabel("Base URL", { exact: true }).fill(current.model.baseUrl);
    await page.getByLabel("Credential name", { exact: true }).fill("offline-model-emulator");
    await page.getByLabel("API key", { exact: true }).fill("offline");
    await page.getByLabel("Default model (optional)", { exact: true }).fill("porkbot-e2e");
    await press(page.getByRole("button", { name: "Connect" }));

    const row = page.locator("[data-connection-row]").filter({ hasText: "Offline model" });
    await expect(row).toBeVisible();
    // The probe names what it found rather than a bare tick.
    await press(row.getByRole("button", { name: "Test" }));
    await expect(page.getByText(/Reachable · 1 model · streaming/)).toBeVisible();

    // The secrets and notifications sections hold what the API carries.
    await rpc(page, "botSecrets/put", {
      botId,
      name: "api_token",
      value: "fixture-value",
      origin: "https://api.example.invalid",
      auth: { type: "bearer" },
    });
    await rpc(page, "notifications/setPreference", {
      kind: "run.failed",
      enabled: true,
    });

    await captureSettings(page, current.origin);
  });
});
