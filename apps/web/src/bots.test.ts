import { describe, expect, it, vi } from "vitest";
import { srgbAccent } from "@porkbot/tokens";
import { fakeThread } from "../test/fakes.ts";
import { formToWriteInput, latestActivity, readComputerHealth, validateBotForm } from "./bots.ts";
import type { BotFormValues } from "./bots.ts";

const valid: BotFormValues = {
  name: " Ada ",
  title: "Researcher",
  description: "Finds the useful detail.",
  instructions: "Be precise.",
  color: srgbAccent,
  sectionId: "",
  computerProvider: " docker ",
};

describe("bot editor rules", () => {
  it("says how to repair invalid fields", () => {
    const errors = validateBotForm({
      ...valid,
      name: " ",
      title: "x".repeat(201),
      description: "x".repeat(4_001),
      instructions: "x".repeat(100_001),
      color: "",
      computerProvider: "x".repeat(65),
    });

    expect(errors).toEqual({
      name: "Enter a name for this bot.",
      title: "Keep the title to 200 characters or fewer.",
      description: "Keep the description to 4,000 characters or fewer.",
      instructions: "Keep the instructions to 100,000 characters or fewer.",
      color: "Choose a colour for this bot.",
      computerProvider: "Keep the computer provider to 64 characters or fewer.",
    });
  });

  it("normalizes optional assignments for the contract", () => {
    expect(formToWriteInput(valid)).toMatchObject({
      name: "Ada",
      sectionId: null,
      computerProvider: "docker",
    });
  });
});

describe("bot list state", () => {
  it("distinguishes running, stopped and failed computer reads", async () => {
    await expect(
      readComputerHealth(
        { computerStatus: vi.fn(async () => ({ assigned: true, state: "running" as const })) },
        "bot-1",
      ),
    ).resolves.toMatchObject({ kind: "healthy" });
    await expect(
      readComputerHealth(
        { computerStatus: vi.fn(async () => ({ assigned: true, state: "stopped" as const })) },
        "bot-1",
      ),
    ).resolves.toMatchObject({ kind: "stopped" });
    await expect(
      readComputerHealth(
        {
          computerStatus: vi.fn(async () => {
            throw new Error("supervisor unavailable");
          }),
        },
        "bot-1",
      ),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("uses the newest thread as the bot's last activity", () => {
    const newer = { ...fakeThread("thread-2", "bot-1"), updatedAt: "2026-02-02T12:00:00.000Z" };

    expect(latestActivity([newer, fakeThread("thread-1", "bot-1")])).toBe(newer.updatedAt);
    expect(latestActivity([])).toBeNull();
  });
});
