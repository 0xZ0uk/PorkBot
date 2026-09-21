// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { themeStyleSheet } from "@porkbot/tokens";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Badge, CountBadge, StateChip } from "./badge.tsx";
import { BotAvatar } from "./bot-avatar.tsx";
import { Button, IconButton } from "./button.tsx";
import { Card } from "./card.tsx";
import { Dialog, Sheet } from "./dialog.tsx";
import { click, focus, renderDom } from "./dom-test.helper.tsx";
import { Field, Input, Select, Textarea } from "./field.tsx";
import { Icon, iconNames } from "./icon.tsx";
import { Menu } from "./menu.tsx";
import { ScrollArea } from "./scroll-area.tsx";
import { Separator } from "./separator.tsx";
import { Skeleton } from "./skeleton.tsx";
import { registerStyleSheet } from "./style-sheet.ts";
import { Tabs } from "./tabs.tsx";
import { ToastProvider, useToast } from "./toast.tsx";
import { Tooltip } from "./tooltip.tsx";

/**
 * The stylesheet is the register's other half: the classes are only a design
 * system if every one of them is drawn, every interactive state has a rule and
 * every token the sheet names exists in `@porkbot/tokens`.
 */

const colourLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/i;

function Pusher() {
  const toast = useToast();

  return (
    <Button
      onClick={() => {
        toast.push({ title: "Run finished", body: "Done.", tone: "success" });
      }}
    >
      Push
    </Button>
  );
}

function Gallery() {
  const [tab, setTab] = useState("screen");
  const [open, setOpen] = useState(false);

  return (
    <ToastProvider>
      <Pusher />
      {(["primary", "neutral", "ghost", "destructive"] as const).map((variant) => (
        <Button key={variant} variant={variant} loading={variant === "primary"}>
          {variant}
        </Button>
      ))}
      <IconButton label="Compress" icon="close" />
      <Tooltip content="A tooltip">
        <Button>Hovered</Button>
      </Tooltip>
      <Field label="Name" hint="Up to 64" error="Required">
        <Input invalid />
      </Field>
      <Textarea rows={2} />
      <Select defaultValue="a">
        <option value="a">A</option>
      </Select>
      {(["accent", "success", "warning", "info", "destructive"] as const).map((tone) => (
        <Badge key={tone} tone={tone}>
          {tone}
        </Badge>
      ))}
      <CountBadge count={2} />
      <StateChip state="waiting" count={2} />
      <BotAvatar id="bot-alpha" name="Alpha" />
      <BotAvatar id="bot-beta" name="Beta" imageUrl="https://example.invalid/b.png" />
      <Card variant="raised">
        <h1>Card</h1>
      </Card>
      <Card variant="interactive">Interactive</Card>
      <Separator />
      <Separator orientation="vertical" />
      <ScrollArea label="Region">
        <p>Scrolled</p>
      </ScrollArea>
      <Tabs
        label="Views"
        active={tab}
        onSelect={setTab}
        items={[
          { id: "screen", label: "Screen", panel: <p>Screen</p> },
          { id: "files", label: "Files", panel: <p>Files</p> },
        ]}
      />
      <Menu
        label="Lifecycle"
        items={[
          { id: "start", label: "Start", onSelect: () => {} },
          { id: "stop", label: "Stop", onSelect: () => {}, destructive: true },
        ]}
      />
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </Button>
      <Dialog open={open} onClose={() => {}} title="Dialog">
        <p>Body</p>
      </Dialog>
      <Sheet open={open} onClose={() => {}} title="Sheet">
        <p>Body</p>
      </Sheet>
      <Skeleton lines={2} />
      <Icon name="check" />
    </ToastProvider>
  );
}

function renderedClasses(html: string): Set<string> {
  const classes = new Set<string>();

  for (const [, value = ""] of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of value.split(/\s+/)) {
      if (token.startsWith("pb-")) {
        classes.add(token);
      }
    }
  }

  return classes;
}

describe("the register stylesheet", () => {
  it("declares no colour literal", () => {
    expect(colourLiteral.test(registerStyleSheet)).toBe(false);
  });

  it("is balanced and covers every interactive state", () => {
    expect((registerStyleSheet.match(/{/g) ?? []).length).toBe(
      (registerStyleSheet.match(/}/g) ?? []).length,
    );

    for (const selector of [
      ".pb-button--primary:hover",
      ".pb-button--neutral:hover",
      ".pb-button--ghost:hover",
      ".pb-button--destructive:hover",
      ".pb-button:focus-visible",
      ".pb-button:disabled",
      ".pb-icon-button:hover",
      ".pb-input:focus-visible",
      '.pb-input[aria-invalid="true"]',
      ".pb-input:disabled",
      ".pb-menu__item:hover",
      ".pb-menu__item:focus-visible",
      ".pb-tab:hover",
      ".pb-tab:focus-visible",
      ".pb-scroll-area:focus-within",
      "@media (prefers-reduced-motion:reduce)",
    ]) {
      expect(registerStyleSheet, `${selector} is missing from the sheet`).toContain(selector);
    }
  });

  it("defines every class the register renders", async () => {
    const { container, unmount } = await renderDom(<Gallery />);
    const buttons = [...container.querySelectorAll("button.pb-button")];
    const push = buttons.find((button) => button.textContent === "Push");
    const open = buttons.find((button) => button.textContent === "Open");

    if (push === undefined || open === undefined) {
      throw new Error("the gallery buttons did not render");
    }

    await click(push);
    await click(open);
    await click(container.querySelector("button[aria-haspopup='menu']") as Element);
    const tooltipTrigger = container.querySelector(".pb-tooltip button");

    if (tooltipTrigger === null) {
      throw new Error("the tooltip trigger did not render");
    }

    await focus(tooltipTrigger);

    const classes = renderedClasses(document.body.innerHTML);

    // The registry is only complete if the gallery rendered, in both its
    // closed and open forms; a class added without a rule fails here.
    for (const name of [
      "pb-button",
      "pb-button--ghost",
      "pb-icon-button",
      "pb-field",
      "pb-input",
      "pb-textarea",
      "pb-select",
      "pb-badge",
      "pb-count-badge",
      "pb-state-chip",
      "pb-avatar",
      "pb-card",
      "pb-separator",
      "pb-scroll-area",
      "pb-tab-list",
      "pb-tab",
      "pb-tab-panel",
      "pb-menu",
      "pb-menu__popup",
      "pb-menu__item",
      "pb-dialog",
      "pb-dialog__panel",
      "pb-sheet",
      "pb-tooltip",
      "pb-tooltip__bubble",
      "pb-toast-region",
      "pb-toast",
      "pb-skeleton",
    ]) {
      expect(classes.has(name), `${name} did not render in the gallery`).toBe(true);
      expect(
        new RegExp(`\\.${name}(?![a-z0-9-])`).test(registerStyleSheet),
        `${name} has no rule in the sheet`,
      ).toBe(true);
    }

    await unmount();
  });

  it("references only token properties the theme declares", () => {
    const declared = new Set(
      [...themeStyleSheet.matchAll(/--pb-[a-z0-9-]+(?=:)/g)].map((match) => match[0]),
    );
    const referenced = new Set(
      [...registerStyleSheet.matchAll(/var\((--pb-[a-z0-9-]+)/g)].map((match) => match[1] ?? ""),
    );
    const local = new Set(["--pb-avatar-color", "--pb-state-chip-color"]);

    for (const name of referenced) {
      if (!local.has(name)) {
        expect(declared.has(name), `${name} is not a token property`).toBe(true);
      }
    }
  });

  it("ships one icon set with no emoji", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "icon.tsx"), "utf8");
    expect(source).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(iconNames.length).toBeGreaterThanOrEqual(8);
  });
});
