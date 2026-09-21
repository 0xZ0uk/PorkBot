// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderDom, keydown } from "./dom-test.helper.tsx";
import { Tabs } from "./tabs.tsx";

function items() {
  return [
    { id: "screen", label: "Screen", panel: <p>Screen panel</p> },
    { id: "terminal", label: "Terminal", panel: <p>Terminal panel</p> },
    { id: "files", label: "Files", panel: <p>Files panel</p> },
  ] as const;
}

describe("Tabs", () => {
  it("marks the active tab selected and hides the other panels", async () => {
    const { container, unmount } = await renderDom(
      <Tabs label="Computer views" items={items()} active="terminal" onSelect={() => {}} />,
    );
    const tabs = [...container.querySelectorAll("[role='tab']")];

    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(container.querySelector("[role='tabpanel']:not([hidden])")?.textContent).toBe(
      "Terminal panel",
    );
    expect(container.querySelectorAll("[role='tabpanel'][hidden]")).toHaveLength(2);
    await unmount();
  });

  it("moves focus and selection with the arrow keys, wrapping at the ends", async () => {
    const onSelect = vi.fn();
    const { container, unmount } = await renderDom(
      <Tabs label="Computer views" items={items()} active="screen" onSelect={onSelect} />,
    );
    const tablist = container.querySelector("[role='tablist']");

    if (tablist === null) {
      throw new Error("the tab list did not render");
    }

    await keydown(tablist, "ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith("terminal");
    expect(document.activeElement?.textContent).toBe("Terminal");

    await keydown(tablist, "ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith("files");

    await keydown(tablist, "Home");
    expect(onSelect).toHaveBeenLastCalledWith("screen");

    await keydown(tablist, "End");
    expect(onSelect).toHaveBeenLastCalledWith("files");
    await unmount();
  });

  it("keeps the active tab in the tab order and the others out", async () => {
    const { container, unmount } = await renderDom(
      <Tabs label="Computer views" items={items()} active="files" onSelect={() => {}} />,
    );
    const tabs = [...container.querySelectorAll("[role='tab']")];
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
    await unmount();
  });
});
