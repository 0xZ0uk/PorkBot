// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { click, keydown, renderDom } from "./dom-test.helper.tsx";
import { Tabs } from "./tabs.tsx";

/** Tabs is controlled: the harness owns the active id the way a screen does. */
function Harness({ onSelect }: { readonly onSelect?: (id: string) => void }) {
  const [active, setActive] = useState("screen");
  return (
    <Tabs
      label="Views"
      active={active}
      onSelect={(id) => {
        setActive(id);
        onSelect?.(id);
      }}
      items={[
        { id: "screen", label: "Screen", panel: <p>Screen panel</p> },
        { id: "terminal", label: "Terminal", panel: <p>Terminal panel</p> },
        { id: "files", label: "Files", panel: <p>Files panel</p> },
      ]}
    />
  );
}

describe("Tabs", () => {
  it("marks the active tab selected and shows its panel", async () => {
    const { container, unmount } = await renderDom(<Harness />);
    const list = [...container.querySelectorAll("[role='tab']")];

    expect(list.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(container.querySelector("[role='tabpanel']")?.textContent).toBe("Screen panel");
    await unmount();
  });

  it("moves focus and selection with the arrow keys, wrapping at the ends", async () => {
    const onSelect = vi.fn();
    const { container, unmount } = await renderDom(<Harness onSelect={onSelect} />);
    const tabsInList = [...container.querySelectorAll("[role='tab']")];
    const active = tabsInList[0];

    if (active === undefined) {
      throw new Error("no tab rendered");
    }

    await keydown(active, "ArrowRight");
    await keydown(document.activeElement as Element, "ArrowRight");
    await keydown(document.activeElement as Element, "ArrowRight");
    expect(onSelect.mock.calls.map((call) => call[0])).toEqual(["terminal", "files", "screen"]);
    expect(document.activeElement?.textContent).toBe("Screen");
    await unmount();
  });

  it("gives only the active tab a tab stop", async () => {
    const { container, unmount } = await renderDom(<Harness />);
    const list = [...container.querySelectorAll("[role='tab']")];
    expect(list.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    await unmount();
  });

  it("selects a tab on click", async () => {
    const onSelect = vi.fn();
    const { container, unmount } = await renderDom(<Harness onSelect={onSelect} />);
    const list = [...container.querySelectorAll("[role='tab']")];
    await click(list[2] as Element);
    expect(onSelect).toHaveBeenLastCalledWith("files");
    await unmount();
  });
});
