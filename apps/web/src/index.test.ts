import { describe, expect, it } from "vitest";
import { moduleInfo } from "./index.ts";

describe("@porkbot/web", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe("@porkbot/web");
  });
});
