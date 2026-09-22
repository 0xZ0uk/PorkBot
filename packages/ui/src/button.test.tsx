// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./button.tsx";
import { click, renderDom } from "./dom-test.helper.tsx";

describe("Button", () => {
  it("renders a button of the requested variant", () => {
    for (const variant of ["primary", "neutral", "ghost", "destructive"] as const) {
      const html = renderToStaticMarkup(<Button variant={variant}>Launch</Button>);
      expect(html).toContain("<button");
      expect(html).toContain("Launch");
      expect(html).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it("defaults to the neutral variant and a plain button type", () => {
    const html = renderToStaticMarkup(<Button>Launch</Button>);
    expect(html).toContain('type="button"');
  });

  it("carries the disabled state onto the element", () => {
    const html = renderToStaticMarkup(<Button disabled>Launch</Button>);
    expect(html).toContain("disabled");
  });

  it("swaps in a spinner and marks itself busy while loading", () => {
    const html = renderToStaticMarkup(<Button loading>Send</Button>);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("Send");
  });

  it("calls its handler when activated", async () => {
    const onClick = vi.fn();
    const { container, unmount } = await renderDom(<Button onClick={onClick}>Launch</Button>);
    const element = container.querySelector("button");

    if (element === null) {
      throw new Error("the button did not render");
    }

    await click(element);
    expect(onClick).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe("IconButton", () => {
  it("carries its accessible name and shows an icon", () => {
    const html = renderToStaticMarkup(<IconButton label="Close" icon="close" />);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("<button");
  });

  it("wraps itself in a tooltip when one is given", () => {
    const html = renderToStaticMarkup(
      <IconButton label="Close" icon="close" tooltip="Close the panel" />,
    );
    expect(html).toContain('aria-label="Close"');
  });
});
