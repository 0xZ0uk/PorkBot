// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { keydown, renderDom } from "./dom-test.helper.tsx";
import { SegmentedControl } from "./segmented-control.tsx";

function options() {
  return [
    { value: "active", label: "Current" },
    { value: "deleted", label: "Removed" },
  ] as const;
}

describe("SegmentedControl", () => {
  it("marks the active segment checked and the others not", async () => {
    const { container, unmount } = await renderDom(
      <SegmentedControl
        label="Documents"
        options={options()}
        value="deleted"
        onChange={() => {}}
      />,
    );
    const segments = [...container.querySelectorAll("[role='radio']")];

    expect(segments.map((segment) => segment.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
    ]);
    await unmount();
  });

  it("moves selection with the arrow keys, wrapping at the ends", async () => {
    const onChange = vi.fn();
    const { container, unmount } = await renderDom(
      <SegmentedControl label="Documents" options={options()} value="active" onChange={onChange} />,
    );
    const group = container.querySelector("[role='radiogroup']");

    if (group === null) {
      throw new Error("the segmented control did not render");
    }

    await keydown(group, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("deleted");
    expect(document.activeElement?.textContent).toBe("Removed");

    // The control is controlled, so `value` stays where the caller put it;
    // End still lands on the last option and Home on the first.
    await keydown(group, "End");
    expect(onChange).toHaveBeenLastCalledWith("deleted");

    await keydown(group, "Home");
    expect(onChange).toHaveBeenLastCalledWith("active");
    await unmount();
  });

  it("keeps the active segment in the tab order and the others out", async () => {
    const { container, unmount } = await renderDom(
      <SegmentedControl label="Documents" options={options()} value="active" onChange={() => {}} />,
    );
    const segments = [...container.querySelectorAll("[role='radio']")];

    expect(segments.map((segment) => segment.getAttribute("tabindex"))).toEqual(["0", "-1"]);
    await unmount();
  });
});
