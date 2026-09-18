import { describe, expect, it } from "vitest";
import { moduleInfo, shellFileName } from "./index.ts";

describe("@porkbot/web", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe("@porkbot/web");
  });

  it("serves the shell TanStack Start writes in SPA mode", () => {
    expect(shellFileName).toBe("_shell.html");
  });
});
