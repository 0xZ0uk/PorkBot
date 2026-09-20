import { describe, expect, it } from "vitest";
import { createSettingsUsageController, usageWindows } from "./settings-usage.ts";
import type { SettingsUsageController, SettingsUsageState } from "./settings-usage.ts";
import { fakeBot, fakeUsage, scriptedUsageTransport } from "../test/fakes.ts";
import type { Bot } from "@porkbot/contracts";

/**
 * The usage settings controller without a DOM: the fan-out over the bot list,
 * the window re-read and both failure directions.
 *
 * The rule under test is that a window change is a re-read, not a local
 * filter: the fake records the window every call asked for, so a controller
 * that quietly filtered would fail here.
 */

async function until(
  controller: SettingsUsageController,
  predicate: (state: SettingsUsageState) => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate(controller.state())) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`timed out waiting for ${label}`);
}

const bots = [fakeBot("bot-1", "Ada"), fakeBot("bot-2", "Grace")];

function loaded(
  usage: ReturnType<typeof scriptedUsageTransport>,
  botList: readonly Bot[] = bots,
): SettingsUsageController {
  const controller = createSettingsUsageController({
    transport: { listBots: async () => botList, forBot: usage.forBot },
  });

  controller.load();

  return controller;
}

describe("the usage settings controller", () => {
  it("reads every bot's report over the default window", async () => {
    const usage = scriptedUsageTransport({
      byBot: { "bot-1": fakeUsage({ botId: "bot-1" }), "bot-2": fakeUsage({ botId: "bot-2" }) },
    });
    const controller = loaded(usage);

    await until(controller, (state) => state.status === "ready", "the read");

    expect(controller.state().days).toBe(30);
    expect(usage.windows).toEqual([30, 30]);
    expect(controller.state().reports.map((report) => report.bot.name)).toEqual(["Ada", "Grace"]);
  });

  it("re-reads every bot when the window changes", async () => {
    const usage = scriptedUsageTransport();
    const controller = loaded(usage);

    await until(controller, (state) => state.status === "ready", "the first read");
    usage.windows.length = 0;
    controller.setDays(usageWindows[2]);

    await until(controller, (state) => state.days === 90, "the window");

    expect(usage.windows).toEqual([90, 90]);
    expect(controller.state().reloading).toBe(false);
  });

  it("ignores a window that is already selected", async () => {
    const usage = scriptedUsageTransport();
    const controller = loaded(usage);

    await until(controller, (state) => state.status === "ready", "the read");
    usage.windows.length = 0;
    controller.setDays(30);

    expect(usage.windows).toEqual([]);
  });

  it("answers a bot with no reports as an empty report, not a dropped row", async () => {
    const controller = loaded(scriptedUsageTransport());

    await until(controller, (state) => state.status === "ready", "the read");

    expect(controller.state().reports).toHaveLength(2);
  });

  it("refuses with one sentence when a read fails", async () => {
    const controller = loaded(scriptedUsageTransport({ failure: new Error("offline") }));

    await until(controller, (state) => state.status === "refused", "the refusal");
    expect(controller.state().refusal).toBe("Usage could not be loaded.");
  });

  it("refuses when no bots can be listed", async () => {
    const usage = scriptedUsageTransport();
    const controller = createSettingsUsageController({
      transport: {
        listBots: async () => {
          throw new Error("offline");
        },
        forBot: usage.forBot,
      },
    });

    controller.load();
    await until(controller, (state) => state.status === "refused", "the refusal");
    expect(controller.state().refusal).toBe("Usage could not be loaded.");
  });
});
