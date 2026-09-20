import { describe, expect, it } from "vitest";
import { trayMenuTemplate, trayTooltip } from "./tray.ts";

describe("the tray", () => {
  it("counts the runs it has seen in flight, singular and plural", () => {
    expect(trayTooltip({ windowVisible: true, activeRuns: 0 })).toBe("PorkBot");
    expect(trayTooltip({ windowVisible: true, activeRuns: 1 })).toBe("PorkBot — 1 run in progress");
    expect(trayTooltip({ windowVisible: false, activeRuns: 3 })).toBe(
      "PorkBot — 3 runs in progress",
    );
  });

  it("labels the show action by what the window is doing", () => {
    const visible = trayMenuTemplate({ windowVisible: true, activeRuns: 0 });
    const hidden = trayMenuTemplate({ windowVisible: false, activeRuns: 0 });

    expect(visible[0]).toMatchObject({ id: "open", label: "Hide PorkBot" });
    expect(hidden[0]).toMatchObject({ id: "open", label: "Show PorkBot" });
  });

  it("carries the actions a web surface cannot: server, updates and quit", () => {
    const template = trayMenuTemplate({ windowVisible: false, activeRuns: 0 });
    const actions = template.filter((item) => item.type === "action");

    expect(actions.map((item) => item.id)).toEqual(["open", "server", "updates", "quit"]);
    expect(actions.every((item) => item.enabled)).toBe(true);
  });
});
