import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar, botAvatarIdentity } from "./bot-avatar.tsx";

describe("BotAvatar", () => {
  it("maps a range of ids deterministically without collapsing to one identity", () => {
    const ids = Array.from({ length: 64 }, (_, index) => `bot-${String(index)}`);
    const first = ids.map((id) => botAvatarIdentity(id));
    const again = ids.map((id) => botAvatarIdentity(id));

    expect(again).toEqual(first);
    expect(new Set(first.map((identity) => identity.shape)).size).toBeGreaterThan(1);
    expect(new Set(first.map((identity) => identity.hueIndex)).size).toBeGreaterThan(1);
    expect(new Set(first.map((identity) => identity.eyeStyle)).size).toBe(2);

    const rendered = renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" />);
    expect(rendered).toBe(renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" />));
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
    expect(html).toContain('alt=""');
    expect(html).not.toContain("<svg");
  });

  it("draws each registered size", () => {
    for (const size of [20, 24, 32, 40] as const) {
      expect(renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" size={size} />)).toContain(
        `pb-avatar--${String(size)}`,
      );
    }
  });

  it("keeps the mascot decorative because the adjacent name carries its meaning", () => {
    const html = renderToStaticMarkup(<BotAvatar id="bot-alpha" name="Alpha" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('aria-label="Alpha"');
  });

  it("keeps an uploaded image decorative as well", () => {
    const html = renderToStaticMarkup(
      <BotAvatar id="bot-alpha" name="Alpha" imageUrl="https://example.invalid/a.png" />,
    );

    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
  });
});
