import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  captureRoster,
  createBot,
  createHarness,
  rpc,
  guardOffline,
  heroShot,
  press,
  signUp,
} from "./support.ts";
import type { BrowserHarness } from "./support.ts";

let harness: BrowserHarness | undefined;

test.beforeAll(async () => {
  harness = await createHarness({ suite: "api_browser_roster" });
});

test.afterAll(async () => {
  await harness?.close();
  harness = undefined;
});

test.describe("the roster and the shell", () => {
  test("carries the empty, populated and archived roster and the shell captures", async ({
    page,
  }) => {
    const current = harness;

    if (current === undefined) {
      throw new Error("the browser harness did not start");
    }

    await guardOffline(page);
    await signUp(page, current.origin);
    // The actor and its repositories come from the browser's own session.
    await current.bindActor(page);

    // The empty roster (slice 13.6): the home a fresh operator lands on,
    // before the first teammate exists.
    await captureRoster(page, current.origin, "roster-empty");

    const botId = await createBot(page, current.origin, {
      name: "Offline Helper",
      title: "Release fixture",
      description: "A deterministic browser bot",
      mission: "Answer using only the offline fixture.",
    });
    await current.attachComputer(botId);

    // The roster captures need more than one teammate, one of them retired.
    const retired = await rpc<{ id: string }>(page, "bots/create", {
      name: "Piper",
      title: "Errands",
      description: "A retired bot",
      mission: "Nothing now.",
      color: "#d946ef",
      spawnKey: randomUUID(),
    });
    await rpc(page, "bots/archive", { id: retired.id });

    await page.goto(current.origin);
    const helper = page.locator("[data-roster-card]").filter({ hasText: "Offline Helper" });
    await press(helper.getByRole("button", { name: "Actions for Offline Helper" }));
    await press(page.getByRole("menuitem", { name: "Pin" }));
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();

    await captureRoster(page, current.origin, "roster-populated", {
      archived: true,
      narrow: true,
    });

    await heroShot(page);
  });
});
