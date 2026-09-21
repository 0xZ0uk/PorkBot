/**
 * A tiny jsdom render helper for the register's interaction tests. The web
 * app's screens hand-roll the same `act` + `createRoot` pattern; this keeps it
 * in one place for the components that need a DOM.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  readonly container: HTMLDivElement;
  readonly root: Root;
  readonly unmount: () => Promise<void>;
}

export async function renderDom(element: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
  });

  return {
    container,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Renders again on the same root, for a controlled-state change. */
export async function rerender(root: Root, element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

/** A press: mousedown then click, which is what a pointer sends. */
export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export async function keydown(element: Element, key: string, shiftKey = false): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });
}

export async function focus(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).focus();
  });
}

/** React synthesises enter/leave from mouseover/mouseout, so send those. */
export async function hover(element: Element, type: "enter" | "leave"): Promise<void> {
  await act(async () => {
    const name = type === "enter" ? "mouseover" : "mouseout";
    element.dispatchEvent(new MouseEvent(name, { bubbles: true, relatedTarget: document.body }));
  });
}
