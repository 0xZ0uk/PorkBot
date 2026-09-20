import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClientRoot } from "./client-root.ts";

describe("the packaged web build's location", () => {
  it("lives beside the app resources when packaged", () => {
    expect(
      resolveClientRoot({
        isPackaged: true,
        resourcesPath: "/opt/PorkBot/resources",
        appDirectory: "/opt/PorkBot/resources/app.asar",
      }),
    ).toBe(path.join("/opt/PorkBot/resources", "client"));
  });

  it("lives where pnpm build wrote it during development", () => {
    expect(
      resolveClientRoot({
        isPackaged: false,
        resourcesPath: "/unused",
        appDirectory: "/checkout/apps/desktop",
      }),
    ).toBe(path.resolve("/checkout/apps/web/dist/client"));
  });
});
