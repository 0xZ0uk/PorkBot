// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { click, renderDom } from "./dom-test.helper.tsx";
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
  it("shows a pushed toast with its action link", async () => {
    const onAction = vi.fn();
    const { container, unmount } = await renderDom(
      <ToastProvider>
        <Pusher onAction={onAction} />
      </ToastProvider>,
    );
    await click(container.querySelector("button") as Element);

    const region = container.querySelector(".pb-toast-region");
    expect(region?.getAttribute("aria-label")).toBe("Notifications");
    expect(region?.textContent).toContain("Run finished");
    expect(region?.textContent).toContain("The offline run completed.");
    expect(container.querySelector(".pb-toast--success")).not.toBeNull();

    const action = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Open the run",
    );

    if (action === undefined) {
      throw new Error("the action link did not render");
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
    expect(container.querySelector(".pb-toast")).not.toBeNull();

    const dismiss = container.querySelector("button[aria-label='Dismiss Run finished']");

    if (dismiss === null) {
      throw new Error("the dismiss control did not render");
    }

    await click(dismiss);
    expect(container.querySelector(".pb-toast")).toBeNull();
    await unmount();
  });

  it("renders destructive run actions as links and urgent announcements", async () => {
    function LinkPusher() {
      const toast = useToast();

      return (
        <button
          type="button"
          onClick={() => {
            toast.push({
              title: "Run failed",
              tone: "destructive",
              action: { label: "Open run", href: "/threads/thread-1?run=run-1" },
            });
          }}
        >
          Push link
        </button>
      );
    }

    const { container, unmount } = await renderDom(
      <ToastProvider>
        <LinkPusher />
      </ToastProvider>,
    );
    await click(container.querySelector("button") as Element);

    const toast = container.querySelector(".pb-toast--destructive");
    expect(toast?.getAttribute("role")).toBe("alert");
    expect(toast?.querySelector("a")?.textContent).toBe("Open run");
    expect(toast?.querySelector("a")?.getAttribute("href")).toBe("/threads/thread-1?run=run-1");
    await unmount();
  });

  it("refuses to be used outside its provider", async () => {
    await expect(renderDom(<Pusher onAction={() => {}} />)).rejects.toThrow(
      "useToast must be used below a ToastProvider.",
    );
  });
});
