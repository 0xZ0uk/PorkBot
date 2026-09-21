import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.tsx";

describe("BotAvatar", () => {
  it("draws the same mascot for the same id and a different one across ids", () => {
    const first = renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" />);
    const again = renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" />);
    expect(again).toBe(first);

    const others = new Set(
      ["a", "b", "c", "d", "e", "f"].map((id) =>
        renderToStaticMarkup(<BotAvatar id={id} name={id} />),
      ),
    );
    expect(others.size).toBeGreaterThan(1);
  });

  it("uses the identity ramp by default and the bot's own colour over it", () => {
    const ramp = renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" />);
    expect(ramp).toContain("var(--pb-color-identity");

    const own = renderToStaticMarkup(
      <BotAvatar id="bot-alpha" name="Alpha" color="var(--bot-hue)" />,
    );
    expect(own).toContain("--pb-avatar-color");
    expect(own).not.toContain("var(--pb-color-identity");
  });

  it("replaces the mascot with an uploaded image", () => {
    const html = renderToStaticMarkup(
      <BotAvatar id="bot-alpha" name="Alpha" imageUrl="https://example.invalid/a.png" />,
    );
    expect(html).toContain("<img");
    expect(html).toContain('alt="Alpha"');
    expect(html).not.toContain("<svg");
  });

  it("draws each registered size", () => {
    for (const size of [20, 24, 32, 40] as const) {
      expect(renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" size={size} />)).toContain(
        `pb-avatar--${String(size)}`,
      );
    }
  });

  it("labels the mascot for assistive technology", () => {
    const html = renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Alpha"');
  });
});
