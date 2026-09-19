// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppRouter } from "../../src/router.tsx";
import { createSessionController } from "../../src/session.ts";
import type { AuthTransport, SessionActor } from "../../src/session.ts";
import { createHttpConnectionsTransport } from "../../src/transport.ts";
import {
  fakeBot,
  fakeConnection,
  fakeCredential,
  fakeProbe,
  scriptedMemoryTransport,
  scriptedThreadTransport,
  scriptedUsageTransport,
} from "../fakes.ts";
import { startScriptedConnectionsApi } from "./scripted-connections-api.ts";
import type { ScriptedConnectionsApi } from "./scripted-connections-api.ts";

/**
 * The connections screen end to end: the built client modules — the contracts'
 * oRPC client, the connections controller and the screen — mounted in a DOM,
 * reading and writing a real HTTP server on loopback.
 *
 * The acceptance criteria this proves: a create stores the key and names it on
 * one connection through the contract; a revoke is immediate and a reload
 * cannot resurrect the key; and a probe's answer — including "streaming
 * unsupported" — is what the screen shows and what the server recorded as the
 * connection's last use.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

beforeEach(() => {
  // jsdom logs "not implemented" for the router's scroll restoration; the
  // subject here is the connections screen, not the scroll position.
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

interface MountedConnections {
  readonly container: HTMLDivElement;
  unmount(): Promise<void>;
}

/**
 * The screen the way a browser gets one: the router guards the route, the
 * connections transport talks to the scripted API over HTTP, and the DOM is
 * the connections screen. Mounting twice is the reload.
 */
async function mountConnections(api: ScriptedConnectionsApi): Promise<MountedConnections> {
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const router = createAppRouter(
    {
      auth,
      session,
      threads: scriptedThreadTransport(),
      memory: scriptedMemoryTransport(),
      usage: scriptedUsageTransport(),
      connections: createHttpConnectionsTransport({ origin: api.url }),
    },
    createMemoryHistory({ initialEntries: ["/settings/connections"] }),
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

/** React's value tracker ignores a plain `element.value =`, so set natively. */
function setValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(container: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    buttonByText(container, text).click();
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("the connections screen over the real wire", () => {
  it("creates a connection and it survives a reload", async () => {
    const api = await startScriptedConnectionsApi();
    const before = await mountConnections(api);

    try {
      await until(
        () => before.container.textContent?.includes("No connections yet.") === true,
        "the empty list",
      );

      await click(before.container, "New connection");

      const form = before.container.querySelector("form.memory-form");

      expect(form).not.toBeNull();

      const [label, baseUrl, credentialName, credentialValue, defaultModel] = [
        ...(form?.querySelectorAll("input") ?? []),
      ] as HTMLInputElement[];

      setValue(label as HTMLInputElement, "Local models");
      setValue(baseUrl as HTMLInputElement, "https://models.example.invalid/v1");
      setValue(credentialName as HTMLInputElement, "model-key");
      setValue(credentialValue as HTMLInputElement, "sk-live-0123456789abcdef");
      setValue(defaultModel as HTMLInputElement, "fixture-model");
      await submit(form as HTMLFormElement);

      await until(
        () => before.container.textContent?.includes("Local models") === true,
        "the created connection",
      );

      expect(before.container.textContent).toContain("model-key");
      expect(before.container.textContent).not.toContain("sk-live-0123456789abcdef");
      expect(api.calls).toContain("credentials/store");
      expect(api.calls).toContain("modelConnections/create");
      expect(api.credentials.map((credential) => credential.name)).toEqual(["model-key"]);
      expect(api.connections.map((connection) => connection.label)).toEqual(["Local models"]);
    } finally {
      await before.unmount();
    }

    // The reload: a fresh client and a fresh controller, with the server's
    // state as the only thing that could remember the connection.
    const after = await mountConnections(api);

    try {
      await until(
        () => after.container.textContent?.includes("Local models") === true,
        "the connection after reload",
      );

      expect(after.container.textContent).toContain("••••test");
    } finally {
      await after.unmount();
      await api.close();
    }
  });

  it("revokes a key and a reload cannot resurrect it", async () => {
    const api = await startScriptedConnectionsApi({
      connections: [fakeConnection({ isDefault: true })],
      credentials: [fakeCredential()],
      bots: [fakeBot("bot-1", "Research")],
    });
    const view = await mountConnections(api);

    try {
      await until(
        () => view.container.textContent?.includes("Local models") === true,
        "the listed connection",
      );

      await click(view.container, "Revoke");

      expect(view.container.textContent).toContain("Revoking model-key leaves Local models");

      await click(view.container, "Revoke key");

      await until(
        () => view.container.textContent?.includes("Revoked model-key.") === true,
        "the revocation notice",
      );

      expect(view.container.textContent).toContain("no key stored");
      expect(api.calls).toContain("credentials/remove");
      expect(api.credentials).toEqual([]);
    } finally {
      await view.unmount();
    }

    const after = await mountConnections(api);

    try {
      await until(
        () => after.container.textContent?.includes("no key stored") === true,
        "the revoked key after reload",
      );

      expect(after.container.textContent).not.toContain("••••cdef");
    } finally {
      await after.unmount();
      await api.close();
    }
  });

  it("probes a connection, records the use, and prints what the endpoint said", async () => {
    const api = await startScriptedConnectionsApi({
      connections: [fakeConnection()],
      probe: fakeProbe({ streaming: false }),
    });
    const view = await mountConnections(api);

    try {
      await until(
        () => view.container.textContent?.includes("Never used") === true,
        "the unprobed connection",
      );

      await click(view.container, "Test");

      await until(
        () => view.container.textContent?.includes("streaming unsupported") === true,
        "the probe's honest answer",
      );

      expect(view.container.textContent).toContain("Reachable · 1 model · streaming unsupported");
      expect(view.container.textContent).toContain("Last used");
      expect(api.calls).toContain("modelConnections/probe");
      expect(api.connections[0]?.lastUsedAt).not.toBeNull();
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("disconnects a connection and its bot falls back to the space default", async () => {
    const api = await startScriptedConnectionsApi({
      connections: [
        fakeConnection({ id: "connection-1", label: "Local models", isDefault: true }),
        fakeConnection({ id: "connection-2", label: "Hosted" }),
      ],
      bots: [{ ...fakeBot("bot-1", "Research"), modelConnectionId: "connection-2" }],
    });
    const view = await mountConnections(api);

    function hostedCard(): Element | undefined {
      return [...view.container.querySelectorAll(".connection")].find((card) =>
        card.textContent?.includes("Hosted"),
      );
    }

    try {
      await until(
        () => view.container.textContent?.includes("Hosted") === true,
        "the two connections",
      );

      await act(async () => {
        [...(hostedCard()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
          .find((button) => button.textContent === "Disconnect")
          ?.click();
      });

      // The confirmation states the fallback before the write.
      expect(view.container.textContent).toContain("1 bot will fall back to the space default.");

      await act(async () => {
        [...(hostedCard()?.querySelectorAll<HTMLButtonElement>(".memory-form button") ?? [])]
          .find((button) => button.textContent === "Disconnect")
          ?.click();
      });

      await until(
        () => view.container.textContent?.includes("Disconnected Hosted.") === true,
        "the disconnect notice",
      );

      expect(view.container.textContent).toContain("1 bot falls back to the space default.");
      expect(api.calls).toContain("modelConnections/remove");
      expect(api.bots[0]?.modelConnectionId).toBeNull();
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("swaps the space default and moves a bot's override", async () => {
    const api = await startScriptedConnectionsApi({
      connections: [
        fakeConnection({ id: "connection-1", label: "Local models", isDefault: true }),
        fakeConnection({ id: "connection-2", label: "Hosted" }),
      ],
      bots: [fakeBot("bot-1", "Research")],
    });
    const view = await mountConnections(api);

    try {
      await until(
        () => view.container.textContent?.includes("Hosted") === true,
        "the two connections",
      );

      const hostedCard = [...view.container.querySelectorAll(".connection")].find((card) =>
        card.textContent?.includes("Hosted"),
      );

      await act(async () => {
        [...(hostedCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
          .find((button) => button.textContent === "Make default")
          ?.click();
      });

      await until(
        () =>
          api.connections.find((connection) => connection.id === "connection-2")?.isDefault ===
          true,
        "the swapped default",
      );

      expect(
        view.container.querySelector(".connection:last-child .connection-badge")?.textContent,
      ).toBe("Space default");

      const select = view.container.querySelector("select");

      await act(async () => {
        const field = select as HTMLSelectElement;

        field.value = "connection-2";
        field.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await until(() => api.bots[0]?.modelConnectionId === "connection-2", "the bot's override");

      expect(view.container.textContent).toContain("Research now uses Hosted.");
    } finally {
      await view.unmount();
      await api.close();
    }
  });
});
