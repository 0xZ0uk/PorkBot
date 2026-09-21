// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { click, keydown, renderDom } from "./dom-test.helper.tsx";
import { Menu } from "./menu.tsx";

function menu(onSelect: () => void = () => {}, destructive = false) {
  return (
    <Menu
      label="Lifecycle"
      items={[
        { id: "start", label: "Start", onSelect },
        { id: "stop", label: "Stop", onSelect, destructive },
        { id: "reset", label: "Reset", onSelect, disabled: true },
      ]}
    />
  );
}

describe("Menu", () => {
  it("takes an accessible name for a trigger whose label needs context", async () => {
    const { container, unmount } = await renderDom(
      <Menu label="Actions" ariaLabel="Actions for Ada" items={[]} />,
    );
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    expect(trigger?.textContent).toContain("Actions");
    expect(trigger?.getAttribute("aria-label")).toBe("Actions for Ada");
    await unmount();
  });

  it("opens from the trigger and marks the popup expanded", async () => {
    const { container, unmount } = await renderDom(menu());
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[role='menu']")).toBeNull();

    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[role='menu']")).not.toBeNull();
    await unmount();
  });

  it("opens with the keyboard and moves through the items", async () => {
    const { container, unmount } = await renderDom(menu());
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    await keydown(trigger, "ArrowDown");
    const items = [...container.querySelectorAll("[role='menuitem']")];
    expect(document.activeElement).toBe(items[0]);

    await keydown(items[0] as Element, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);

    await keydown(items[1] as Element, "ArrowUp");
    expect(document.activeElement).toBe(items[0]);

    // The last item is disabled, so End lands on the last item that can take
    // focus; Home walks back the same way.
    await keydown(items[0] as Element, "End");
    expect(document.activeElement).toBe(items[1]);

    await keydown(items[1] as Element, "Home");
    expect(document.activeElement).toBe(items[0]);
    await unmount();
  });

  it("steps over a disabled item instead of stalling on it", async () => {
    const { container, unmount } = await renderDom(menu());
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    await keydown(trigger, "ArrowDown");
    const items = [...container.querySelectorAll("[role='menuitem']")];

    // Reset, the last item, is disabled: ArrowUp from the first item wraps
    // past it to Stop rather than focusing nothing.
    await keydown(items[0] as Element, "ArrowUp");
    expect(document.activeElement).toBe(items[1]);

    await keydown(items[1] as Element, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);

    await keydown(items[0] as Element, "End");
    expect(document.activeElement).toBe(items[1]);
    await unmount();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { container, unmount } = await renderDom(menu());
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    await keydown(trigger, "ArrowDown");
    const item = container.querySelector("[role='menuitem']");

    if (item === null) {
      throw new Error("the menu did not open");
    }

    await keydown(item, "Escape");
    expect(container.querySelector("[role='menu']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await unmount();
  });

  it("closes after a selection and keeps the destructive item marked", async () => {
    const onSelect = vi.fn();
    const { container, unmount } = await renderDom(menu(onSelect, true));
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    await keydown(trigger, "ArrowDown");
    const items = [...container.querySelectorAll("[role='menuitem']")];
    expect(items[1]?.className).toContain("pb-menu__item--destructive");

    await click(items[1] as Element);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role='menu']")).toBeNull();
    await unmount();
  });

  it("closes on a press outside", async () => {
    const { container, unmount } = await renderDom(
      <div>
        {menu()}
        <button type="button">Elsewhere</button>
      </div>,
    );
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    await click(trigger);
    expect(container.querySelector("[role='menu']")).not.toBeNull();

    const outside = container.querySelector("button:not([aria-haspopup])");

    if (outside === null) {
      throw new Error("the outside button did not render");
    }

    await click(outside);
    expect(container.querySelector("[role='menu']")).toBeNull();
    await unmount();
  });
});
