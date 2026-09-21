import { renderToStaticMarkup } from "react-dom/server";
import { colors } from "@porkbot/tokens";
import { describe, expect, it } from "vitest";
import { Button } from "./button.tsx";

describe("Button", () => {
  it("renders its label inside a button element", () => {
    const html = renderToStaticMarkup(<Button>Launch</Button>);
    expect(html).toContain("<button");
    expect(html).toContain("Launch");
  });

  it("draws the primary tone from the palette's accent property", () => {
    const html = renderToStaticMarkup(<Button tone="primary">Launch</Button>);
    expect(html).toContain(colors.accent);
  });
});
