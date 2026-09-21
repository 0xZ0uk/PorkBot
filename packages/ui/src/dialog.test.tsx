// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { click, keydown, renderDom } from "./dom-test.helper.tsx";
import { Dialog, Sheet } from "./dialog.tsx";

/** A real opener: the dialog is opened and closed through its own state. */
function Harness() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        id="opener"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Stop the machine?"
        description="The run stops where it is."
        actions={<button type="button">Confirm</button>}
      >
        <p>Body</p>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("opens as a modal, labelled by its title and description", async () => {
    const { unmount } = await renderDom(<Harness />);
    await click(document.querySelector("#opener") as Element);

    const panel = document.querySelector("[role='dialog']");
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(panel?.getAttribute("aria-labelledby")).not.toBeNull();
    expect(panel?.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.body.textContent).toContain("Stop the machine?");
    await unmount();
  });

  it("moves focus into the panel, closes on Escape and returns focus to the opener", async () => {
    const { unmount } = await renderDom(<Harness />);
    const opener = document.querySelector("#opener") as HTMLElement;
    // A real press focuses the button before the click handler runs.
    opener.focus();
    await click(opener);

    const panel = document.querySelector("[role='dialog']") as HTMLElement;
    expect(document.activeElement).toBe(panel);

    await keydown(panel, "Escape");
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(opener);
    await unmount();
  });

  it("closes on a press on the backdrop but not inside the panel", async () => {
    const onClose = vi.fn();
    const { unmount } = await renderDom(
      <Dialog open onClose={onClose} title="Stop the machine?">
        <p>Body</p>
      </Dialog>,
    );
    const panel = document.querySelector("[role='dialog']");

    if (panel === null) {
      throw new Error("the dialog did not open");
    }

    await click(panel);
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = panel.parentElement;

    if (backdrop === null) {
      throw new Error("the backdrop is missing");
    }

    await click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("wraps Tab inside the panel", async () => {
    const { unmount } = await renderDom(
      <Dialog open onClose={() => {}} title="Stop the machine?" actions={<button>Confirm</button>}>
        <button type="button">Cancel</button>
      </Dialog>,
    );
    const panel = document.querySelector("[role='dialog']");

    if (panel === null) {
      throw new Error("the dialog did not open");
    }

    const buttons = [...panel.querySelectorAll("button")];
    const last = buttons[buttons.length - 1];

    if (last === undefined) {
      throw new Error("the dialog has no controls");
    }

    last.focus();
    await keydown(last, "Tab");
    expect(document.activeElement).toBe(buttons[0]);
    await unmount();
  });

  it("renders a sheet with the sheet placement", async () => {
    const { unmount } = await renderDom(
      <Sheet open onClose={() => {}} title="Choose a provider">
        <p>Provider</p>
      </Sheet>,
    );
    const backdrop = document.querySelector(".pb-dialog");
    expect(backdrop?.className).toContain("pb-sheet");
    await unmount();
  });
});
