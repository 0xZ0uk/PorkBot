import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card } from "./card.tsx";
import { Separator } from "./separator.tsx";

describe("Card", () => {
  it("renders a surface with its body and the heading type", () => {
    const html = renderToStaticMarkup(
      <Card>
        <h1>Sign in</h1>
        <p>Body</p>
      </Card>,
    );
    expect(html).toContain("<h1>Sign in</h1>");
    expect(html).toContain("<p>Body</p>");
    expect(html).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|oklch\(/i);
  });

  it("draws the element the caller needs, such as a form", () => {
    const html = renderToStaticMarkup(
      <Card as="form" aria-busy={false}>
        <h1>Sign in</h1>
      </Card>,
    );
    expect(html).toContain("<form");
    expect(html).not.toContain("as=");
  });

  it("switches elevation by variant without a colour literal", () => {
    for (const variant of ["flat", "raised", "interactive"] as const) {
      const html = renderToStaticMarkup(<Card variant={variant}>Body</Card>);
      expect(html).toContain("<div");
      expect(html).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|oklch\(/i);
    }
  });
});

describe("Separator", () => {
  it("draws a horizontal separator by default and a vertical one on request", () => {
    const horizontal = renderToStaticMarkup(<Separator />);
    expect(horizontal).toContain('aria-orientation="horizontal"');

    const vertical = renderToStaticMarkup(<Separator orientation="vertical" label="Sections" />);
    expect(vertical).toContain('aria-orientation="vertical"');
    expect(vertical).toContain('aria-label="Sections"');
  });
});
