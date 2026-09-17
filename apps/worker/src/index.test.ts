import { describe, expect, it } from "vitest";
import { moduleInfo, workerModules } from "./index.ts";

describe("@porkbot/worker", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe("@porkbot/worker");
  });

  it("wires the modules the worker process composes", () => {
    expect(workerModules).toContain("@porkbot/db");
    expect(workerModules).toContain("@porkbot/effect");
  });
});
