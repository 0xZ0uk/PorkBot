import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, CountBadge, StateChip } from "./badge.tsx";
import type { StateChipState } from "./badge.tsx";

describe("Badge", () => {
  it("renders its label and draws no colour literal", () => {
    const html = renderToStaticMarkup(<Badge>Default</Badge>);
    expect(html).toContain("Default");
    expect(html).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|oklch\(/i);
  });

  it("takes every tone without changing the words", () => {
    for (const tone of [
      "neutral",
      "accent",
      "success",
      "warning",
      "info",
      "destructive",
    ] as const) {
      const html = renderToStaticMarkup(<Badge tone={tone}>State</Badge>);
      expect(html).toContain("State");
    }
  });
});

describe("CountBadge", () => {
  it("shows the number", () => {
    const html = renderToStaticMarkup(<CountBadge count={3} />);
    expect(html).toContain("3");
  });
});

describe("StateChip", () => {
  const words: Record<string, string> = {
    idle: "Idle",
    working: "Working",
    waiting: "Waiting for you",
    stuck: "Stuck",
    failed: "Failed",
    stopped: "Stopped",
  };

  it("pairs each state with its word so state is never colour alone", () => {
    for (const state of Object.keys(words) as StateChipState[]) {
      const html = renderToStaticMarkup(<StateChip state={state} />);
      expect(html).toContain(`data-state="${state}"`);
      expect(html).toContain(words[state] as string);
    }
  });

  it("shows the pending count only on the waiting chip", () => {
    expect(renderToStaticMarkup(<StateChip state="waiting" count={4} />)).toContain("4");
    expect(renderToStaticMarkup(<StateChip state="working" count={4} />)).not.toContain("4");
  });

  it("lets a bot's own colour drive the working dot", () => {
    const html = renderToStaticMarkup(<StateChip state="working" color="#abcdef" />);
    expect(html).toContain("--pb-state-chip-color");
    expect(html).toContain("#abcdef");
  });
});
