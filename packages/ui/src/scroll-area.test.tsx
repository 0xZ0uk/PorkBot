// @vitest-environment jsdom
import { act, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderDom } from "./dom-test.helper.tsx";
import { ScrollArea } from "./scroll-area.tsx";

describe("ScrollArea", () => {
  it("is a named, focusable region that can cap its height", async () => {
    const { container, unmount } = await renderDom(
      <ScrollArea label="Transcript" maxHeight="20rem">
        <p>One</p>
      </ScrollArea>,
    );

    const region = container.querySelector(".pb-scroll-area");

    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("aria-label")).toBe("Transcript");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.getAttribute("style")).toContain("max-height: 20rem");

    return unmount();
  });

  it("hands the caller the element it scrolls and every scroll event", async () => {
    const onScroll = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const { container, unmount } = await renderDom(
      <ScrollArea label="Transcript" onScroll={onScroll} ref={ref}>
        <p>One</p>
      </ScrollArea>,
    );

    const region = container.querySelector<HTMLDivElement>(".pb-scroll-area");

    expect(ref.current).toBe(region);

    // jsdom has no layout, so the event a real scroll would send is dispatched.
    await act(async () => {
      region?.dispatchEvent(new Event("scroll"));
    });

    expect(onScroll).toHaveBeenCalledTimes(1);

    return unmount();
  });
});
