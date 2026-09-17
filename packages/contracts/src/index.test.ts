import { describe, expect, it } from "vitest";
import { moduleInfo } from "./index.ts";

describe("@porkbot/contracts", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe("@porkbot/contracts");
  });
});
