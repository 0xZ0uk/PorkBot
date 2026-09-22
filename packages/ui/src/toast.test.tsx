// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast as sonner } from "sonner";
import { click, renderDom } from "./dom-test.helper.tsx";

// sonner portals its region out of the test container and into `document.body`.
const surface = (): HTMLElement => document.body;
import { ToastProvider, useToast } from "./toast.tsx";

function Pusher({ onAction }: { readonly onAction: () => void }) {
  const toast = useToast();

  return (
    <button
      type="button"
      onClick={() => {
        toast.push({
          title: "Run finished",
          body: "The offline run completed.",
          tone: "success",
          action: { label: "Open the run", onClick: onAction },
        });
      }}
    >
      Push
    </button>
  );
}

describe("Toast", () => {
  // sonner keeps one queue for the whole page, so a toast left by an earlier
  // case would still be here for the next one to find.
  beforeEach(() => {
    sonner.dismiss();
  });

  it("shows a pushed toast with its action button", async () => {
    const onAction = vi.fn();
    const { container, unmount } = await renderDom(
      <ToastProvider>
        <Pusher onAction={onAction} />
      </ToastProvider>,
    );
    await click(container.querySelector("button") as Element);

    await vi.waitFor(() => {
      expect(surface().textContent).toContain("Run finished");
    });
    expect(surface().textContent).toContain("The offline run completed.");

    const action = [...surface().querySelectorAll("button")].find(
      (button) => button.textContent === "Open the run",
    );

    if (action === undefined) {
      throw new Error("the action button did not render");
    }

    await click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("dismisses from its labelled control", async () => {
    const { container, unmount } = await renderDom(
      <ToastProvider>
        <Pusher onAction={() => {}} />
      </ToastProvider>,
    );
    await click(container.querySelector("button") as Element);
    await vi.waitFor(() => {
      expect(surface().textContent).toContain("Run finished");
    });

    const card = [...surface().querySelectorAll("li")].find((item) =>
      item.textContent?.includes("Run finished"),
    );
    const close = card === undefined ? undefined : [...card.querySelectorAll("button")].find(
      (button) => /close/i.test(button.getAttribute("aria-label") ?? ""),
    );

    if (close === undefined) {
      throw new Error("no labelled control to dismiss from");
    }

    await click(close);
    await vi.waitFor(() => {
      expect(surface().textContent).not.toContain("Run finished");
    });
    await unmount();
  });

  it("renders a destination as a link and an urgent announcement", async () => {
    const { container, unmount } = await renderDom(
      <ToastProvider>
        <Announcer />
      </ToastProvider>,
    );
    await click(container.querySelector("button") as Element);

    await vi.waitFor(() => {
      expect(surface().textContent).toContain("Run failed");
    });
    const link = [...surface().querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Open the run",
    );

    if (link === undefined) {
      throw new Error("the destination did not render as a link");
    }

    expect(link.getAttribute("href")).toBe("/runs/7");
    await unmount();
  });
});

function Announcer() {
  const toast = useToast();

  return (
    <button
      type="button"
      onClick={() => {
        toast.push({
          title: "Run failed",
          body: "The computer provider refused the command.",
          tone: "destructive",
          action: { label: "Open the run", href: "/runs/7" },
        });
      }}
    >
      Push
    </button>
  );
}
