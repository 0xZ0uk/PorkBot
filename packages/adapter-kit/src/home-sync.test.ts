import { describe, expect, it } from "vitest";
import { COMPUTER_HOME_SYNC } from "./home-sync.ts";
import type { ComputerHomeSyncStory } from "./home-sync.ts";
import { PROVIDER_INTERFACES } from "./provider-plan.ts";

/**
 * The home-sync check (slice 7.7): every computer provider the plan declares
 * must say, in `COMPUTER_HOME_SYNC`, either how its home reaches the storage
 * seam or that it is explicitly not backed up. The validator is exercised
 * against a broken register too, so a check that stops firing fails here rather
 * than quietly passing.
 */

function computerProviders(): readonly string[] {
  const seam = PROVIDER_INTERFACES.find((entry) => entry.interface === "ComputerProvider");

  return seam === undefined ? [] : seam.implementations.map((entry) => entry.name);
}

function validateHomeSync(
  providers: readonly string[],
  stories: readonly ComputerHomeSyncStory[],
): string[] {
  const errors: string[] = [];
  const storyOf = new Map<string, ComputerHomeSyncStory>();

  for (const story of stories) {
    if (storyOf.has(story.provider)) {
      errors.push(`home sync for ${story.provider} is stated twice`);
      continue;
    }

    storyOf.set(story.provider, story);

    if (story.story.trim() === "") {
      errors.push(`home sync for ${story.provider} says nothing`);
    }

    if (!story.throughStorage && !story.story.toLowerCase().includes("not backed up")) {
      errors.push(
        `home sync for ${story.provider} routes outside storage but does not say it is not backed up`,
      );
    }
  }

  for (const provider of providers) {
    if (!storyOf.has(provider)) {
      errors.push(`computer provider ${provider} has no home-sync story`);
    }
  }

  for (const story of stories) {
    if (!providers.includes(story.provider)) {
      errors.push(`home sync names ${story.provider}, which the provider plan does not declare`);
    }
  }

  return errors;
}

describe("the computer home sync story", () => {
  it("states a story for every planned computer provider, and only those", () => {
    expect(validateHomeSync(computerProviders(), COMPUTER_HOME_SYNC)).toEqual([]);
  });

  it("proves the check fails on a missing story", () => {
    expect(
      validateHomeSync(
        ["createDockerComputerProvider"],
        [
          {
            provider: "ComputerEmulator",
            story: "not backed up",
            throughStorage: false,
          },
        ],
      ),
    ).toEqual([
      "computer provider createDockerComputerProvider has no home-sync story",
      "home sync names ComputerEmulator, which the provider plan does not declare",
    ]);
  });

  it("proves the check fails on an orphan story and on a silent one", () => {
    expect(
      validateHomeSync(
        [],
        [
          { provider: "createUnlistedComputerProvider", story: "somewhere", throughStorage: true },
          { provider: "ComputerEmulator", story: "   ", throughStorage: true },
        ],
      ),
    ).toEqual([
      "home sync for ComputerEmulator says nothing",
      "home sync names createUnlistedComputerProvider, which the provider plan does not declare",
      "home sync names ComputerEmulator, which the provider plan does not declare",
    ]);
  });

  it("proves the check fails when a provider outside storage does not say so", () => {
    expect(
      validateHomeSync(
        [],
        [{ provider: "ComputerEmulator", story: "in memory", throughStorage: false }],
      ),
    ).toEqual([
      "home sync for ComputerEmulator routes outside storage but does not say it is not backed up",
      "home sync names ComputerEmulator, which the provider plan does not declare",
    ]);
  });
});
