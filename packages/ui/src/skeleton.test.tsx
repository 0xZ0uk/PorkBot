import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton.tsx";

describe("Skeleton", () => {
  it("draws one bar by default and a stack on request", () => {
    expect(renderToStaticMarkup(<Skeleton />).match(/pb-skeleton[" ]/g)).toHaveLength(1);

    const stack = renderToStaticMarkup(<Skeleton lines={3} />);
    expect(stack).toContain("pb-skeleton-group");
    expect(stack.match(/pb-skeleton[" ]/g)).toHaveLength(3);
  });

  it("is hidden from assistive technology", () => {
    const html = renderToStaticMarkup(<Skeleton width="60%" height="1rem" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("width:60%");
    expect(html).toContain("height:1rem");
  });
});
