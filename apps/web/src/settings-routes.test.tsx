// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";
import { createSessionController } from "./session.ts";
import type { AuthTransport, SessionActor } from "./session.ts";
import {
  fakeBot,
  fakeBotSecret,
  fakeMcpServerDetail,
  scriptedBotsTransport,
  scriptedComputerTransport,
  scriptedConnectionsTransport,
  scriptedMcpTransport,
  scriptedMemoryTransport,
  scriptedNotificationsTransport,
  scriptedOwnershipTransport,
  scriptedSecretsTransport,
  scriptedThreadTransport,
  scriptedUsageTransport,
} from "../test/fakes.ts";
import type { McpTransport } from "./mcp.ts";
import type { SecretsTransport } from "./secrets.ts";

/**
 * The settings area in a real DOM (slice 11.5): the index's links all resolve,
 * and each surface renders the server's own words — the switches, the usage
 * totals, the owner, the secrets and the MCP registry.
 *
 * The destructive pair is the point of the secrets and MCP cases: both arm a
 * confirmation whose sentence states the consequence, and only the second
 * click writes. The transports are scripted fakes, so the assertion after the
 * write is that the fake's state moved, which is what a reload would show.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

function fakeAuth(): AuthTransport {
  return {
    currentActor: vi.fn(async () => actor),
    signIn: vi.fn(async () => undefined),
    signUp: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    signupAvailability: vi.fn(async () => "closed" as const),
  };
}

interface SettingsWorld {
  readonly mcp?: McpTransport;
  readonly secrets?: SecretsTransport;
  readonly notifications?: ReturnType<typeof scriptedNotificationsTransport>;
  readonly ownership?: ReturnType<typeof scriptedOwnershipTransport>;
  readonly usage?: ReturnType<typeof scriptedUsageTransport>;
}

function appFor(path: string, world: SettingsWorld = {}) {
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const bots = [fakeBot("bot-1", "Ada"), fakeBot("bot-2", "Grace")];
  const usage = world.usage ?? scriptedUsageTransport();

  return {
    usage,
    router: createAppRouter(
      {
        auth,
        session,
        bots: scriptedBotsTransport({
          listBots: async () => bots,
          listThreads: async () => [],
        }),
        threads: scriptedThreadTransport(),
        memory: scriptedMemoryTransport(),
        usage,
        connections: scriptedConnectionsTransport(),
        computer: scriptedComputerTransport(),
        notifications: world.notifications ?? scriptedNotificationsTransport(),
        ownership:
          world.ownership ??
          scriptedOwnershipTransport({ role: "owner", ownerEmail: "owner@example.invalid" }),
        secrets:
          world.secrets ??
          scriptedSecretsTransport({
            bots,
            secrets: { "bot-1": [fakeBotSecret()] },
          }),
        mcp: world.mcp ?? scriptedMcpTransport(),
      },
      createMemoryHistory({ initialEntries: [path] }),
    ),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.scrollTo = () => undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function mount(path: string, world: SettingsWorld = {}): Promise<void> {
  const { router } = appFor(path, world);

  await act(async () => {
    await router.load();
  });
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );

  if (found === undefined) {
    throw new Error(`no button labelled "${text}"`);
  }

  return found;
}

async function click(text: string): Promise<void> {
  await act(async () => {
    buttonByText(text).click();
  });
}

/** React's value tracker ignores a plain `element.value =`, so set natively. */
function setSelect(element: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;

  setter?.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the settings index", () => {
  it("lists every settings surface as a link", async () => {
    await mount("/settings");
    await until(
      () => container.textContent?.includes("MCP servers") === true,
      "the settings index",
    );

    const links = [...container.querySelectorAll<HTMLAnchorElement>("a")].map((link) =>
      link.getAttribute("href"),
    );

    for (const path of [
      "/settings/connections",
      "/settings/mcp",
      "/settings/secrets",
      "/settings/notifications",
      "/settings/usage",
      "/settings/account",
    ]) {
      expect(links, path).toContain(path);
    }
  });

  it("resolves every link it lists, so no entry is a dead end", async () => {
    await mount("/settings");
    await until(
      () => container.textContent?.includes("MCP servers") === true,
      "the settings index",
    );

    const links = [...container.querySelectorAll<HTMLAnchorElement>("a")]
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/settings/"));

    expect(links).toHaveLength(6);

    for (const path of links) {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);

      await mount(path);
      await until(
        () =>
          container.querySelector("h2") !== null &&
          container.textContent !== null &&
          !container.textContent.includes("Not found"),
        `the surface at ${path}`,
      );

      expect(container.textContent, path).not.toContain("Settings could not");
    }
  });
});

describe("the notification settings surface", () => {
  it("flips a switch and renders the server's whole set", async () => {
    const notifications = scriptedNotificationsTransport();

    await mount("/settings/notifications", { notifications });
    await until(() => container.textContent?.includes("Run failed") === true, "the switches");

    const failed = [...container.querySelectorAll("input")].find(
      (input) => input.closest("label")?.textContent === "Run failed",
    );

    await act(async () => {
      (failed as HTMLInputElement).click();
    });

    await until(
      () =>
        [...container.querySelectorAll<HTMLInputElement>("input")].some(
          (input) => input.closest("label")?.textContent === "Run failed" && input.checked,
        ),
      "the flipped switch",
    );
  });
});

describe("the usage settings surface", () => {
  it("reads every bot and re-reads when the window changes", async () => {
    const usage = scriptedUsageTransport();

    await mount("/settings/usage", { usage });
    await until(() => container.textContent?.includes("Ada") === true, "the per-bot totals");

    expect(container.textContent).toContain("Grace");
    expect(container.textContent).toContain("Recorded and displayed only");

    const select = container.querySelector("select") as HTMLSelectElement;

    await act(async () => {
      setSelect(select, "90");
    });

    await until(() => usage.windows.includes(90), "the window re-read");
  });
});

describe("the account settings surface", () => {
  it("shows the actor's role and the deployment owner", async () => {
    await mount("/settings/account");
    await until(
      () => container.textContent?.includes("owner@example.invalid") === true,
      "the ownership read",
    );

    expect(container.textContent).toContain("Owner");
    expect(container.textContent).toContain("Deployment owner");
  });

  it("says a deployment has no configured owner rather than leaving a blank", async () => {
    await mount("/settings/account", {
      ownership: scriptedOwnershipTransport({ role: "member", ownerEmail: null }),
    });
    await until(
      () => container.textContent?.includes("No owner configured") === true,
      "the missing owner",
    );

    expect(container.textContent).toContain("Member");
  });
});

describe("the secrets settings surface", () => {
  it("states what forgetting costs before the write, then reports the clear", async () => {
    const secrets = scriptedSecretsTransport({
      bots: [fakeBot("bot-1", "Ada")],
      secrets: { "bot-1": [fakeBotSecret({ name: "api_token" })] },
    });

    await mount("/settings/secrets", { secrets });
    await until(() => container.textContent?.includes("api_token") === true, "the secret row");

    await click("Forget");

    expect(container.textContent).toContain(
      "Forgetting api_token clears the stored value now; a request that uses it fails until it is stored again.",
    );

    await click("Forget value");

    await until(
      () => container.textContent?.includes("The stored value was cleared.") === true,
      "the forget outcome",
    );
    expect(secrets.calls).toContain("forget");
  });
});

describe("the MCP settings surface", () => {
  it("opens a server, confirms what removing it takes down, and removes it", async () => {
    const mcp = scriptedMcpTransport({
      servers: [fakeMcpServerDetail({ id: "server-1", name: "Fixture server" })],
      bots: [fakeBot("bot-1", "Ada")],
    });

    await mount("/settings/mcp", { mcp });
    await until(
      () => container.textContent?.includes("Fixture server") === true,
      "the server list",
    );

    await click("Open");
    await until(() => container.textContent?.includes("search") === true, "the tool list");

    await click("Remove");

    expect(container.textContent).toContain(
      "Removing Fixture server deletes 1 tool and its stored credential; 0 bots lose access.",
    );

    await click("Remove server");

    await until(
      () => container.textContent?.includes("Removed Fixture server.") === true,
      "the removal outcome",
    );
    expect(mcp.servers).toEqual([]);
  });

  it("keeps an OAuth install's consent link in front of the operator", async () => {
    const mcp = scriptedMcpTransport({
      authorizationUrl: "https://auth.example.invalid/consent",
    });

    await mount("/settings/mcp", { mcp });
    await until(
      () => container.textContent?.includes("No servers installed.") === true,
      "the empty list",
    );

    await click("Install server");

    const form = container.querySelector("form.memory-form") as HTMLFormElement;
    const [name, url] = [...(form?.querySelectorAll("input") ?? [])] as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

    setter?.call(name as HTMLInputElement, "OAuth server");
    name?.dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(url as HTMLInputElement, "https://mcp.example.invalid/mcp");
    url?.dispatchEvent(new Event("input", { bubbles: true }));

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await until(
      () => container.textContent?.includes("Open the consent page") === true,
      "the consent link",
    );

    const consent = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Open the consent page",
    );

    expect(consent?.getAttribute("href")).toBe("https://auth.example.invalid/consent");
    expect(mcp.servers.map((server) => server.name)).toEqual(["OAuth server"]);
  });
});
