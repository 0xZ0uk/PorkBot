import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton.tsx";

describe("Skeleton", () => {
  it("draws one bar by default and a stack on request", () => {
    expect(renderToStaticMarkup(<Skeleton />).match(/aria-hidden="true"/g)).toHaveLength(1);

    const stack = renderToStaticMarkup(<Skeleton lines={3} />);
    expect(stack.match(/<span/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("is hidden from assistive technology and carries its size", () => {
    const html = renderToStaticMarkup(<Skeleton width="60%" height="1rem" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("width:60%");
    expect(html).toContain("height:1rem");
  });
});
