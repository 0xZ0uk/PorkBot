import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card } from "./card.tsx";
import { Separator } from "./separator.tsx";

describe("Card", () => {
  it("renders flat by default and each variant as a class", () => {
    expect(renderToStaticMarkup(<Card>Body</Card>)).toContain("pb-card");
    expect(renderToStaticMarkup(<Card variant="raised">Body</Card>)).toContain("pb-card--raised");
    expect(renderToStaticMarkup(<Card variant="interactive">Body</Card>)).toContain(
      "pb-card--interactive",
    );
  });

  it("draws the element the caller needs, such as a form", () => {
    const html = renderToStaticMarkup(
      <Card as="form" aria-busy={false}>
        <h1>Sign in</h1>
      </Card>,
    );
    expect(html).toContain("<form");
    expect(html).toContain("pb-card");
    expect(html).not.toContain("as=");
  });

  it("draws no colour literal", () => {
    expect(renderToStaticMarkup(<Card variant="raised">Body</Card>)).not.toMatch(
      /#[0-9a-f]{3,8}|rgba?\(|oklch\(/i,
    );
  });
});

describe("Separator", () => {
  it("draws a horizontal rule by default and a vertical one on request", () => {
    const horizontal = renderToStaticMarkup(<Separator />);
    expect(horizontal).toContain("pb-separator--horizontal");
    expect(horizontal).toContain('aria-orientation="horizontal"');

    const vertical = renderToStaticMarkup(<Separator orientation="vertical" label="Sections" />);
    expect(vertical).toContain("pb-separator--vertical");
    expect(vertical).toContain('aria-label="Sections"');
  });
});
