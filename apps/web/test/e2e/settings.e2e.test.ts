// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppRouter } from "../../src/router.tsx";
import { createSessionController } from "../../src/session.ts";
import type { AuthTransport, SessionActor } from "../../src/session.ts";
import {
  createHttpBotsTransport,
  createHttpMcpTransport,
  createHttpNotificationsTransport,
  createHttpOwnershipTransport,
  createHttpSecretsTransport,
  createHttpUsageTransport,
} from "../../src/transport.ts";
import {
  fakeBot,
  fakeBotSecret,
  fakeMcpServerDetail,
  scriptedComputerTransport,
  scriptedConnectionsTransport,
  scriptedMemoryTransport,
  scriptedThreadTransport,
} from "../fakes.ts";
import { startScriptedSettingsApi } from "./scripted-settings-api.ts";
import type { ScriptedSettingsApi } from "./scripted-settings-api.ts";

/**
 * The settings area end to end: the built client modules — the contracts' oRPC
 * client, the controllers and the screens — mounted in a DOM, reading and
 * writing a real HTTP server on loopback.
 *
 * The acceptance criteria this proves: a notification switch flips through the
 * contract and the server's whole set comes back; usage is read per bot over a
 * chosen window; the account reads the deployment's owner; a secret forget
 * states the consequence and clears the value; and an MCP server installs,
 * shows the consent link when it needs one, and uninstalls with its grants.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

beforeEach(() => {
  // jsdom logs "not implemented" for the router's scroll restoration; the
  // subject here is the settings area, not the scroll position.
  window.scrollTo = () => undefined;
});

function fakeAuth(): AuthTransport {
  return {
    currentActor: async () => actor,
    signIn: async () => undefined,
    signUp: async () => undefined,
    signOut: async () => undefined,
    signupAvailability: async () => "closed" as const,
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

interface MountedSettings {
  readonly container: HTMLDivElement;
  unmount(): Promise<void>;
}

/**
 * The area the way a browser gets one: the router guards the route, the
 * settings transports talk to the scripted API over HTTP, and the DOM is the
 * screen. Mounting twice is the reload.
 */
async function mountSettings(api: ScriptedSettingsApi, path: string): Promise<MountedSettings> {
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const origin = { origin: api.url };
  const router = createAppRouter(
    {
      auth,
      session,
      bots: createHttpBotsTransport(origin),
      threads: scriptedThreadTransport(),
      memory: scriptedMemoryTransport(),
      usage: createHttpUsageTransport(origin),
      connections: scriptedConnectionsTransport(),
      computer: scriptedComputerTransport(),
      notifications: createHttpNotificationsTransport(origin),
      ownership: createHttpOwnershipTransport(origin),
      secrets: createHttpSecretsTransport(origin),
      mcp: createHttpMcpTransport(origin),
    },
    createMemoryHistory({ initialEntries: [path] }),
  );
  const container = document.createElement("div");

  document.body.append(container);
  const root: Root = createRoot(container);

  await act(async () => {
    await router.load();
  });
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
  });

  return {
    container,

    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );

  if (found === undefined) {
    throw new Error(`no button labelled "${text}"`);
  }

  return found as HTMLButtonElement;
}

async function click(container: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    buttonByText(container, text).click();
  });
}

/** React's value tracker ignores a plain `element.value =`, so set natively. */
function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  setter?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

describe("the settings area over the real wire", () => {
  it("flips a notification switch and renders the server's set", async () => {
    const api = await startScriptedSettingsApi();
    const view = await mountSettings(api, "/settings/notifications");

    try {
      await until(
        () => view.container.textContent?.includes("Run stalled") === true,
        "the switches",
      );

      const stalled = [...view.container.querySelectorAll<HTMLInputElement>("input")].find(
        (input) => input.closest("label")?.textContent === "Run stalled",
      );

      await act(async () => {
        stalled?.click();
      });

      await until(
        () => api.preferences.some((entry) => entry.kind === "run.stalled" && entry.enabled),
        "the stored switch",
      );

      expect(api.calls).toContain("notifications/setPreference");
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("reads every bot's usage and re-reads when the window changes", async () => {
    const api = await startScriptedSettingsApi({ bots: [fakeBot("bot-1", "Ada")] });
    const view = await mountSettings(api, "/settings/usage");

    try {
      await until(() => api.usageWindows.length > 0, "the per-bot report");

      expect(view.container.textContent).toContain("Ada");
      expect(view.container.textContent).toContain("Recorded and displayed only");
      expect(api.usageWindows).toEqual([30]);

      const select = view.container.querySelector("select") as HTMLSelectElement;

      await act(async () => {
        setValue(select, "90");
      });

      await until(() => api.usageWindows.includes(90), "the window re-read");
      expect(api.calls).toContain("usage/bot");
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("shows the deployment's owner and the actor's role", async () => {
    const api = await startScriptedSettingsApi({ ownerEmail: "ops@example.invalid" });
    const view = await mountSettings(api, "/settings/account");

    try {
      await until(
        () => view.container.textContent?.includes("ops@example.invalid") === true,
        "the ownership read",
      );

      expect(view.container.textContent).toContain("Owner");
      expect(api.calls).toContain("account/ownership");
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("forgets a secret behind a confirmation that states the cost", async () => {
    const api = await startScriptedSettingsApi({
      bots: [fakeBot("bot-1", "Ada")],
      secrets: [fakeBotSecret({ name: "api_token" })],
    });
    const view = await mountSettings(api, "/settings/secrets");

    try {
      await until(
        () => view.container.textContent?.includes("api_token") === true,
        "the secret row",
      );

      await click(view.container, "Forget");

      expect(view.container.textContent).toContain(
        "Forgetting api_token clears the stored value now; a request that uses it fails until it is stored again.",
      );

      await click(view.container, "Forget value");

      await until(
        () => view.container.textContent?.includes("The stored value was cleared.") === true,
        "the forget outcome",
      );

      expect(api.secrets[0]?.status).toBe("forgotten");
      expect(api.calls).toContain("botSecrets/remove");
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("uninstalls an MCP server and takes its grants with it", async () => {
    const api = await startScriptedSettingsApi({
      bots: [fakeBot("bot-1", "Ada")],
      servers: [fakeMcpServerDetail({ id: "server-1", name: "Fixture server" })],
      grants: [["server-1", "bot-1"]],
    });
    const view = await mountSettings(api, "/settings/mcp");

    try {
      await until(
        () => view.container.textContent?.includes("Fixture server") === true,
        "the server list",
      );

      await click(view.container, "Open");
      await until(
        () =>
          view.container.querySelector(".connection-key")?.textContent?.includes("Ada") === true,
        "the grant row",
      );

      await click(view.container, "Remove");

      expect(view.container.textContent).toContain(
        "Removing Fixture server deletes 1 tool and its stored credential; 1 bot loses access.",
      );

      await click(view.container, "Remove server");

      await until(() => api.servers.length === 0, "the removal");
      await until(
        () => view.container.textContent?.includes("Removed Fixture server.") === true,
        "the removal outcome",
      );

      expect(api.grants).toEqual([]);
      expect(api.calls).toContain("mcpServers/remove");
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("installs an OAuth server and leaves its consent link in front of the operator", async () => {
    const api = await startScriptedSettingsApi({
      authorizationUrl: "https://auth.example.invalid/consent",
    });
    const view = await mountSettings(api, "/settings/mcp");

    try {
      await until(
        () => view.container.textContent?.includes("No servers installed.") === true,
        "the empty list",
      );

      await click(view.container, "Install server");

      const form = view.container.querySelector("form.memory-form") as HTMLFormElement;
      const [name, url] = [...form.querySelectorAll("input")] as HTMLInputElement[];
      const select = form.querySelector("select") as HTMLSelectElement;

      await act(async () => {
        setValue(name as HTMLInputElement, "OAuth server");
        setValue(url as HTMLInputElement, "https://mcp.example.invalid/mcp");
        setValue(select, "oauth");
      });

      const clientId = form.querySelectorAll("input")[2] as HTMLInputElement;

      await act(async () => {
        setValue(clientId, "client-1");
      });

      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      await until(
        () => view.container.textContent?.includes("Open the consent page") === true,
        "the consent link",
      );

      const consent = [...view.container.querySelectorAll<HTMLAnchorElement>("a")].find(
        (link) => link.textContent === "Open the consent page",
      );

      expect(consent?.getAttribute("href")).toBe("https://auth.example.invalid/consent");
      expect(api.servers.map((server) => server.name)).toEqual(["OAuth server"]);
      expect(api.servers[0]?.status).toBe("pending_authorization");
      expect(api.calls).toContain("mcpServers/create");
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("keeps a settings surface's data after a reload", async () => {
    const api = await startScriptedSettingsApi({
      bots: [fakeBot("bot-1", "Ada")],
      enabled: ["run.failed"],
    });
    const first = await mountSettings(api, "/settings/notifications");

    try {
      await until(
        () =>
          [...first.container.querySelectorAll<HTMLInputElement>("input")].some(
            (input) => input.closest("label")?.textContent === "Run failed" && input.checked,
          ),
        "the stored switch",
      );
    } finally {
      await first.unmount();
    }

    const second = await mountSettings(api, "/settings/notifications");

    try {
      await until(
        () =>
          [...second.container.querySelectorAll<HTMLInputElement>("input")].some(
            (input) => input.closest("label")?.textContent === "Run failed" && input.checked,
          ),
        "the switch after reload",
      );
    } finally {
      await second.unmount();
      await api.close();
    }
  });
});
