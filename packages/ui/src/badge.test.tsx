import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, CountBadge, StateChip } from "./badge.tsx";
import type { StateChipState } from "./badge.tsx";

describe("Badge", () => {
  it("renders each tone as a class, with neutral as the default", () => {
    expect(renderToStaticMarkup(<Badge>Default</Badge>)).toContain("pb-badge");
    expect(renderToStaticMarkup(<Badge>Default</Badge>)).not.toContain("pb-badge--");

    for (const tone of ["accent", "success", "warning", "info", "destructive"] as const) {
      expect(renderToStaticMarkup(<Badge tone={tone}>State</Badge>)).toContain(`pb-badge--${tone}`);
    }
  });

  it("draws no colour literal", () => {
    const html = renderToStaticMarkup(<Badge tone="success">Done</Badge>);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|oklch\(/i);
  });
});

describe("CountBadge", () => {
  it("shows the count", () => {
    const html = renderToStaticMarkup(<CountBadge count={3} />);
    expect(html).toContain("pb-count-badge");
    expect(html).toContain("3");
  });
});

describe("StateChip", () => {
  const words: Readonly<Record<StateChipState, string>> = {
    idle: "Idle",
    working: "Working",
    waiting: "Waiting for you",
    stuck: "Stuck",
    failed: "Failed",
    stopped: "Stopped",
  };

  it("renders the six-word vocabulary with a dot and a class per state", () => {
    for (const state of Object.keys(words) as StateChipState[]) {
      const html = renderToStaticMarkup(<StateChip state={state} />);
      expect(html).toContain(`pb-state-chip--${state}`);
      expect(html).toContain(`data-state="${state}"`);
      expect(html).toContain(words[state]);
      expect(html).toContain("pb-state-chip__dot");
    }
  });

  it("shows the count only on the waiting chip", () => {
    expect(renderToStaticMarkup(<StateChip state="waiting" count={4} />)).toContain(
      "pb-count-badge",
    );
    expect(renderToStaticMarkup(<StateChip state="working" count={4} />)).not.toContain(
      "pb-count-badge",
    );
  });

  it("passes the bot's colour to the working dot", () => {
    const html = renderToStaticMarkup(<StateChip state="working" color="var(--bot-hue)" />);
    expect(html).toContain("--pb-state-chip-color");
  });
});
