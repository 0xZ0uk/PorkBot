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
  fakeConnection,
  fakeCredential,
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
import type { ConnectionsTransport } from "./connections.ts";
import type { McpTransport } from "./mcp.ts";
import type { SecretsTransport } from "./secrets.ts";

/**
 * The settings surface in a real DOM (slice 13.13): one panel reached from the
 * rail, six sections inline with their current values, a section nav whose
 * every link resolves to a section, and the explicit mode control.
 *
 * The destructive pair keeps its point: MCP removal, credential revoke, secret
 * forget and a store over a stored name (rotate) all arm a confirmation whose
 * sentence states the consequence, and only the second click writes. The
 * transports are scripted fakes, so the assertion after a write is that the
 * fake's state moved — what a reload would show.
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
  readonly connections?: ConnectionsTransport;
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
        connections: world.connections ?? scriptedConnectionsTransport(),
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
  // jsdom leaves scrollIntoView unimplemented; the panel's hash landing and
  // the router's own hash scroll both call it.
  Element.prototype.scrollIntoView = () => undefined;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  delete document.documentElement.dataset["theme"];
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

async function mount(
  path: string,
  world: SettingsWorld = {},
): Promise<ReturnType<typeof createAppRouter>> {
  const { router } = appFor(path, world);

  await act(async () => {
    await router.load();
  });
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
  });

  return router;
}

function section(id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`#${id}`);

  if (found === null) {
    throw new Error(`no settings section #${id}`);
  }

  return found;
}

function buttonIn(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );

  if (found === undefined) {
    throw new Error(`no button labelled "${text}"`);
  }

  return found;
}

async function clickIn(scope: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    buttonIn(scope, text).click();
  });
}

/** React's value tracker ignores a plain `element.value =`, so set natively. */
function setControl(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  setter?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

async function fill(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    setControl(element, value);
  });
}

describe("the settings surface", () => {
  it("opens from the rail and carries every section behind one panel", async () => {
    await mount("/");

    const railLink = container.querySelector<HTMLAnchorElement>("a[href='/settings']");

    expect(railLink).not.toBeNull();

    await act(async () => {
      railLink?.click();
    });

    await until(() => container.querySelector("#models") !== null, "the settings surface");

    expect(container.querySelector("h2")?.textContent).toBe("Settings");
    expect(container.querySelector("nav[aria-label='Settings sections']")).not.toBeNull();
  });

  it("links every section it names to a section that exists", async () => {
    await mount("/settings");
    await until(() => container.querySelector("#account") !== null, "the six sections");

    const links = [
      ...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings sections"] a'),
    ];

    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#models",
      "#mcp",
      "#secrets",
      "#notifications",
      "#usage",
      "#account",
    ]);

    for (const link of links) {
      const href = link.getAttribute("href") ?? "";

      expect(container.querySelector(href), href).not.toBeNull();
    }
  });

  it("shows each section's current values without a further click", async () => {
    const bots = [fakeBot("bot-1", "Ada"), fakeBot("bot-2", "Grace")];

    await mount("/settings", {
      connections: scriptedConnectionsTransport({
        connections: [fakeConnection({ id: "connection-1", label: "Local models" })],
        credentials: [fakeCredential({ name: "model-key" })],
        bots,
      }),
      mcp: scriptedMcpTransport({
        servers: [fakeMcpServerDetail({ id: "server-1", name: "Fixture server" })],
        bots,
      }),
      secrets: scriptedSecretsTransport({
        bots,
        secrets: { "bot-1": [fakeBotSecret({ name: "api_token" })] },
      }),
      notifications: scriptedNotificationsTransport({ enabled: ["run.failed"] }),
    });

    await until(
      () => container.textContent?.includes("Local models") === true,
      "the connections read",
    );

    for (const heading of [
      "Models and connections",
      "MCP servers",
      "Secrets",
      "Notifications",
      "Usage",
      "Account",
    ]) {
      expect(container.textContent, heading).toContain(heading);
    }

    // One value per section, read from the fakes the panel was opened with:
    // no section waits on a click to say what it holds.
    expect(section("models").textContent).toContain("Local models");
    expect(section("mcp").textContent).toContain("Fixture server");
    expect(section("secrets").textContent).toContain("api_token");
    expect(section("usage").textContent).toContain("Ada");
    expect(section("account").textContent).toContain("owner@example.invalid");

    const failed = [...section("notifications").querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.closest("label")?.textContent === "Run failed",
    );

    expect(failed?.checked).toBe(true);
  });

  it("marks the section a nav link points at", async () => {
    await mount("/settings");
    await until(() => container.querySelector("#account") !== null, "the six sections");

    const secretsLink = [
      ...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings sections"] a'),
    ].find((link) => link.textContent === "Secrets");

    expect(secretsLink?.getAttribute("aria-current")).toBeNull();

    await act(async () => {
      secretsLink?.click();
    });

    expect(secretsLink?.getAttribute("aria-current")).toBe("true");
  });

  it("lands an old per-section path on the section it named", async () => {
    const router = await mount("/settings/mcp");

    await until(() => container.querySelector("#mcp") !== null, "the panel");

    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.location.hash).toBe("mcp");
  });

  it("treats a settings path with no section as not found", async () => {
    await mount("/settings/sepia");

    await until(
      () => container.textContent?.includes("Page not found") === true,
      "the not-found screen",
    );
  });

  it("marks the section a hash names", async () => {
    window.location.hash = "secrets";

    await mount("/settings");
    await until(() => container.querySelector("#account") !== null, "the six sections");

    const secretsLink = [
      ...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings sections"] a'),
    ].find((link) => link.textContent === "Secrets");

    expect(secretsLink?.getAttribute("aria-current")).toBe("true");
  });

  it("marks the last section once the pane reaches its end", async () => {
    const globals = globalThis as unknown as { ResizeObserver?: unknown };
    const original = globals.ResizeObserver;

    // jsdom has no ResizeObserver; a stub lets the panel register its layout
    // observer and the scroll listener, which is what this case exercises.
    class SilentObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    globals.ResizeObserver = SilentObserver;

    try {
      await mount("/settings");
      await until(() => container.querySelector("#account") !== null, "the six sections");

      const pane = container.querySelector<HTMLElement>("[data-shell-pane]");

      if (pane === null) {
        throw new Error("the content pane is missing");
      }

      Object.defineProperty(pane, "scrollTop", { value: 900, configurable: true });
      Object.defineProperty(pane, "clientHeight", { value: 900, configurable: true });
      Object.defineProperty(pane, "scrollHeight", { value: 1800, configurable: true });

      await act(async () => {
        pane.dispatchEvent(new Event("scroll"));
      });

      const accountLink = [
        ...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings sections"] a'),
      ].find((link) => link.textContent === "Account");

      expect(accountLink?.getAttribute("aria-current")).toBe("true");
    } finally {
      if (original === undefined) {
        delete globals.ResizeObserver;
      } else {
        globals.ResizeObserver = original;
      }
    }
  });
});

describe("the settings mode control", () => {
  it("stores an explicit choice and paints it", async () => {
    await mount("/settings");
    await until(() => container.querySelector("[data-settings-mode]") !== null, "the mode control");

    const mode = container.querySelector<HTMLElement>("[data-settings-mode]");

    await clickIn(mode as HTMLElement, "Light");

    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(window.localStorage.getItem("porkbot.theme")).toBe("light");
    expect(buttonIn(mode as HTMLElement, "Light").getAttribute("aria-pressed")).toBe("true");
  });

  it("stores System and clears the attribute, so the media query decides", async () => {
    document.documentElement.dataset["theme"] = "dark";

    await mount("/settings");
    await until(() => container.querySelector("[data-settings-mode]") !== null, "the mode control");

    const mode = container.querySelector<HTMLElement>("[data-settings-mode]");

    await clickIn(mode as HTMLElement, "System");

    expect(document.documentElement.dataset["theme"]).toBeUndefined();
    expect(window.localStorage.getItem("porkbot.theme")).toBe("system");
  });

  it("offers the same three choices in the rail footer", async () => {
    await mount("/");

    const footer = container.querySelector<HTMLElement>("nav[aria-label='Workspace']");

    expect(footer).not.toBeNull();

    const trigger = [...(footer as HTMLElement).querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.startsWith("Mode:") === true,
    );

    expect(trigger).toBeDefined();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The register's menu portals its popup, so the items sit on the body.
    const items = [...document.body.querySelectorAll("[role='menuitem']")].map(
      (item) => item.textContent,
    );

    expect(items).toEqual(["System", "Light", "Dark"]);

    await clickIn(document.body, "Dark");

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(window.localStorage.getItem("porkbot.theme")).toBe("dark");
  });
});

describe("the secrets section", () => {
  it("states what forgetting costs before the write, then reports the clear", async () => {
    const secrets = scriptedSecretsTransport({
      bots: [fakeBot("bot-1", "Ada")],
      secrets: { "bot-1": [fakeBotSecret({ name: "api_token" })] },
    });

    await mount("/settings", { secrets });
    await until(
      () => section("secrets").textContent?.includes("api_token") === true,
      "the secret row",
    );

    await clickIn(section("secrets"), "Forget");

    expect(section("secrets").textContent).toContain(
      "Forgetting api_token clears the stored value now; a request that uses it fails until it is stored again.",
    );

    await clickIn(section("secrets"), "Forget value");

    await until(
      () => section("secrets").textContent?.includes("The stored value was cleared.") === true,
      "the forget outcome",
    );
    expect(secrets.calls).toContain("forget");
  });

  it("confirms a store over a stored name as a rotate that replaces the value", async () => {
    const secrets = scriptedSecretsTransport({
      bots: [fakeBot("bot-1", "Ada")],
      secrets: { "bot-1": [fakeBotSecret({ name: "api_token" })] },
    });

    await mount("/settings", { secrets });
    await until(
      () => section("secrets").textContent?.includes("api_token") === true,
      "the secret row",
    );

    await clickIn(section("secrets"), "Store secret");

    const form = section("secrets").querySelector("form.memory-form") as HTMLFormElement;
    const [name, value, origin] = [...form.querySelectorAll("input")] as HTMLInputElement[];

    await fill(name as HTMLInputElement, "api_token");
    await fill(value as HTMLInputElement, "rotated-value");
    await fill(origin as HTMLInputElement, "https://api.example.invalid");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(section("secrets").textContent).toContain(
      "A secret named api_token is already stored. Storing now replaces its value; a request that used the old value fails until the new one is accepted.",
    );

    await clickIn(section("secrets"), "Replace value");

    await until(
      () => section("secrets").textContent?.includes("Stored api_token.") === true,
      "the rotate outcome",
    );
    expect(secrets.calls).toContain("store");
  });
});

describe("the MCP section", () => {
  it("keeps an OAuth install's consent link in front of the operator", async () => {
    const mcp = scriptedMcpTransport({
      authorizationUrl: "https://auth.example.invalid/consent",
    });

    await mount("/settings", { mcp });
    await until(
      () => section("mcp").textContent?.includes("No servers installed.") === true,
      "the empty list",
    );

    await clickIn(section("mcp"), "Install server");

    const form = section("mcp").querySelector("form.memory-form") as HTMLFormElement;
    const [name, url] = [...form.querySelectorAll("input")] as HTMLInputElement[];
    const auth = form.querySelector("select") as HTMLSelectElement;

    await fill(name as HTMLInputElement, "OAuth server");
    await fill(url as HTMLInputElement, "https://mcp.example.invalid/mcp");
    await fill(auth, "oauth");

    const clientId = form.querySelectorAll("input")[2] as HTMLInputElement;

    await fill(clientId, "client-1");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await until(
      () => section("mcp").textContent?.includes("Open the consent page") === true,
      "the consent link",
    );

    const consent = [...section("mcp").querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Open the consent page",
    );

    expect(consent?.getAttribute("href")).toBe("https://auth.example.invalid/consent");
    expect(mcp.servers.map((server) => server.name)).toEqual(["OAuth server"]);
  });

  it("opens a server, confirms what removing it takes down, and removes it", async () => {
    const mcp = scriptedMcpTransport({
      servers: [fakeMcpServerDetail({ id: "server-1", name: "Fixture server" })],
      bots: [fakeBot("bot-1", "Ada")],
    });

    await mount("/settings", { mcp });
    await until(
      () => section("mcp").textContent?.includes("Fixture server") === true,
      "the server list",
    );

    await clickIn(section("mcp"), "Open");
    await until(() => section("mcp").textContent?.includes("search") === true, "the tool list");

    await clickIn(section("mcp"), "Remove");

    expect(section("mcp").textContent).toContain(
      "Removing Fixture server deletes 1 tool and its stored credential; 0 bots lose access.",
    );

    await clickIn(section("mcp"), "Remove server");

    await until(
      () => section("mcp").textContent?.includes("Removed Fixture server.") === true,
      "the removal outcome",
    );
    expect(mcp.servers).toEqual([]);
  });
});

describe("the models and connections section", () => {
  it("confirms what revoking a key leaves without a key", async () => {
    const connections = scriptedConnectionsTransport({
      connections: [fakeConnection({ id: "connection-1", label: "Local models" })],
      credentials: [fakeCredential({ name: "model-key" })],
      bots: [fakeBot("bot-1", "Ada")],
    });

    await mount("/settings", { connections });
    await until(
      () => section("models").textContent?.includes("model-key") === true,
      "the stored key",
    );

    await clickIn(section("models"), "Revoke");

    expect(section("models").textContent).toContain(
      "Revoking model-key leaves Local models without a key",
    );

    await clickIn(section("models"), "Revoke key");

    await until(
      () => section("models").textContent?.includes("Revoked model-key.") === true,
      "the revoke outcome",
    );
  });
});
