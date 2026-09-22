// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { focus, hover, renderDom } from "./dom-test.helper.tsx";
import { Tooltip } from "./tooltip.tsx";

describe("Tooltip", () => {
  it("shows on hover and hides on leave", async () => {
    const { container, unmount } = await renderDom(
      <Tooltip content="Compress the transcript">
        <button type="button">Compress</button>
      </Tooltip>,
    );
    const trigger = container.querySelector("button");

    if (trigger === null) {
      throw new Error("the trigger did not render");
    }

    expect(document.querySelector("[role='tooltip']")).toBeNull();

    await hover(trigger, "enter");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe("Compress the transcript");

    await hover(trigger, "leave");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelector("[role='tooltip']")).toBeNull();
    await unmount();
  });

  it("shows on focus of the trigger and describes it", async () => {
    const { container, unmount } = await renderDom(
      <Tooltip content="Compress the transcript">
        <button type="button">Compress</button>
      </Tooltip>,
    );
    const button = container.querySelector("button");

    if (button === null) {
      throw new Error("the trigger did not render");
    }

    await focus(button);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const bubble = document.querySelector("[role='tooltip']");
    expect(bubble?.textContent).toBe("Compress the transcript");
    expect(button.getAttribute("aria-describedby")).toBe(bubble?.id);
    await unmount();
  });
});
