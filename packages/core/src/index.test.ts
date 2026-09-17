import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moduleInfo } from "./index.ts";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  name: string;
  dependencies?: Record<string, string>;
};

describe("@porkbot/core", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe(packageJson.name);
  });

  it("has no runtime dependencies", () => {
    expect(packageJson.dependencies ?? {}).toEqual({});
  });
});

// PROOF ONLY — reverted in the next commit.
export const deliberateTypeError: number = "a string is not a number";
