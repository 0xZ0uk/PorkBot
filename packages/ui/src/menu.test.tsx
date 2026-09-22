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

const surface = (): HTMLElement => document.body;

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
    expect(surface().querySelector("[role='menu']")).toBeNull();

    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(surface().querySelector("[role='menu']")).not.toBeNull();
    await unmount();
  });

  it("opens with the keyboard and lists its items", async () => {
    const { container, unmount } = await renderDom(menu());
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    await keydown(trigger, "ArrowDown");
    const items = [...surface().querySelectorAll("[role='menuitem']")];
    expect(items.map((item) => item.textContent)).toEqual(["Start", "Stop", "Reset"]);
    await unmount();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { container, unmount } = await renderDom(menu());
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    await click(trigger);
    const item = surface().querySelector("[role='menuitem']");

    if (item === null) {
      throw new Error("the menu did not open");
    }

    (item as HTMLElement).focus();
    await keydown(item, "Escape");
    expect(surface().querySelector("[role='menu']")).toBeNull();
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

    await click(trigger);
    const items = [...surface().querySelectorAll("[role='menuitem']")];
    expect(items[1]?.textContent).toBe("Stop");
    expect(items[1]?.className).toContain("text-destructive");

    await click(items[1] as Element);
    expect(onSelect).toHaveBeenCalled();
    expect(surface().querySelector("[role='menu']")).toBeNull();
    await unmount();
  });

  it("closes on a press outside", async () => {
    const { container, unmount } = await renderDom(menu());
    const trigger = container.querySelector("button[aria-haspopup='menu']");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    await click(trigger);
    expect(surface().querySelector("[role='menu']")).not.toBeNull();

    await click(document.body);
    expect(surface().querySelector("[role='menu']")).toBeNull();
    await unmount();
  });
});
