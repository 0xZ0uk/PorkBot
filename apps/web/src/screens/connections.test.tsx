// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsState } from "../connections.ts";
import { ConnectionsScreen } from "./connections.tsx";
import { fakeBot, fakeConnection, fakeCredential, fakeProbe } from "../../test/fakes.ts";

/**
 * The connections screen in a real DOM: the list reads as label, endpoint,
 * masked key, last use and the probe's own answer; the destructive pair arms a
 * confirmation that states the consequence before the write; and the bot list
 * distinguishes a space-default follower from an override.
 *
 * The fixture is the state a loaded controller would hand over, so no network
 * and no controller is involved — the screen is a function of its props.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function state(overrides: Partial<ConnectionsState> = {}): ConnectionsState {
  return {
    status: "ready",
    refusal: null,
    connections: [],
    credentials: [],
    bots: [],
    probes: {},
    notice: null,
    pending: null,
    ...overrides,
  };
}

function screenProps(state: ConnectionsState) {
  return {
    state,
    onReload: vi.fn(),
    onProbe: vi.fn(),
    onSetDefault: vi.fn(async () => undefined),
    onDisconnect: vi.fn(async () => undefined),
    onRevoke: vi.fn(async () => undefined),
    onCreate: vi.fn(async () => true),
    onSetBotConnection: vi.fn(async () => undefined),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function buttonWith(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );

  if (button === undefined) {
    throw new Error(`no button labelled "${label}"`);
  }

  return button;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    buttonWith(label).click();
  });
}

describe("the connections list", () => {
  it("reads as label, provider, masked key, last use and status", async () => {
    await render(
      <ConnectionsScreen
        {...screenProps(
          state({
            connections: [
              fakeConnection({
                isDefault: true,
                lastUsedAt: "2026-09-19T10:00:00.000Z",
              }),
            ],
          }),
        )}
      />,
    );

    const card = container.querySelector(".connection");

    expect(card?.querySelector("h3")?.textContent).toBe("Local models");
    expect(card?.textContent).toContain("models.example.invalid");
    expect(card?.textContent).toContain("model-key");
    expect(card?.textContent).toContain("••••cdef");
    expect(card?.textContent).toContain("Last used");
    expect(card?.textContent).toContain("Not tested yet");
    expect(card?.textContent).toContain("Space default");
  });

  it("says Never used for a connection no request has left for", async () => {
    await render(
      <ConnectionsScreen {...screenProps(state({ connections: [fakeConnection()] }))} />,
    );

    expect(container.textContent).toContain("Never used");
  });

  it("marks a missing key and names the probe's refusal", async () => {
    await render(
      <ConnectionsScreen
        {...screenProps(
          state({
            connections: [
              fakeConnection({ id: "connection-1", credentialMaskedValue: null }),
              fakeConnection({
                id: "connection-2",
                label: "Hosted",
                credentialMaskedValue: null,
              }),
            ],
            probes: {
              "connection-2": {
                status: "answered",
                probe: fakeProbe({
                  reachable: false,
                  models: [],
                  streaming: false,
                  failure: "auth_failed",
                }),
              },
            },
          }),
        )}
      />,
    );

    expect(container.textContent).toContain("no key stored");
    expect(container.textContent).toContain("Key refused");
  });

  it("prints streaming unsupported rather than guessing", async () => {
    await render(
      <ConnectionsScreen
        {...screenProps(
          state({
            connections: [fakeConnection()],
            probes: {
              "connection-1": {
                status: "answered",
                probe: fakeProbe({ streaming: false, models: [{ id: "fixture-model" }] }),
              },
            },
          }),
        )}
      />,
    );

    expect(container.textContent).toContain("Reachable · 1 model · streaming unsupported");
  });

  it("reports a probe the transport could not complete", async () => {
    await render(
      <ConnectionsScreen
        {...screenProps(
          state({
            connections: [fakeConnection()],
            probes: { "connection-1": { status: "failed" } },
          }),
        )}
      />,
    );

    expect(container.textContent).toContain("The endpoint could not be tested.");
  });

  it("names the failure kinds in words", async () => {
    await render(
      <ConnectionsScreen
        {...screenProps(
          state({
            connections: [
              fakeConnection({ id: "connection-1", label: "One" }),
              fakeConnection({ id: "connection-2", label: "Two" }),
              fakeConnection({ id: "connection-3", label: "Three" }),
              fakeConnection({ id: "connection-4", label: "Four" }),
            ],
            probes: {
              "connection-1": {
                status: "answered",
                probe: fakeProbe({
                  reachable: false,
                  models: [],
                  streaming: false,
                  failure: "gone",
                }),
              },
              "connection-2": {
                status: "answered",
                probe: fakeProbe({
                  reachable: false,
                  models: [],
                  streaming: false,
                  failure: "rate_limited",
                }),
              },
              "connection-3": {
                status: "answered",
                probe: fakeProbe({
                  reachable: false,
                  models: [],
                  streaming: false,
                  failure: "timed_out",
                }),
              },
              "connection-4": {
                status: "answered",
                probe: fakeProbe({
                  reachable: false,
                  models: [],
                  streaming: false,
                  failure: "not_found",
                }),
              },
            },
          }),
        )}
      />,
    );

    expect(container.textContent).toContain("Endpoint unreachable");
    expect(container.textContent).toContain("Rate limited");
    expect(container.textContent).toContain("Timed out");
    expect(container.textContent).toContain("Model not found");
  });

  it("surfaces an empty list as a sentence", async () => {
    await render(<ConnectionsScreen {...screenProps(state())} />);

    expect(container.textContent).toContain("No connections yet.");
    expect(container.textContent).toContain("No stored keys.");
  });

  it("shows the refused state with one retry", async () => {
    const props = screenProps(
      state({ status: "refused", refusal: "Connections could not be loaded." }),
    );

    await render(<ConnectionsScreen {...props} />);
    expect(container.textContent).toContain("Connections could not be loaded.");

    await click("Try again");
    expect(props.onReload).toHaveBeenCalledTimes(1);
  });
});

describe("the destructive pair", () => {
  it("asks before revoking and states which connections and bots lose out", async () => {
    const props = screenProps(
      state({
        connections: [fakeConnection({ isDefault: true })],
        credentials: [fakeCredential()],
        bots: [{ ...fakeBot("bot-1", "Research"), modelConnectionId: "connection-1" }],
      }),
    );

    await render(<ConnectionsScreen {...props} />);
    await click("Revoke");

    expect(container.textContent).toContain(
      "Revoking model-key leaves Local models without a key and 1 bot has no model.",
    );

    await click("Revoke key");
    expect(props.onRevoke).toHaveBeenCalledWith("model-key");
  });

  it("cancels a revoke without writing", async () => {
    const props = screenProps(state({ credentials: [fakeCredential()] }));

    await render(<ConnectionsScreen {...props} />);
    await click("Revoke");
    await click("Cancel");

    expect(props.onRevoke).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Revoking model-key");
  });

  it("asks before disconnecting and says when the space default is going away", async () => {
    const props = screenProps(
      state({
        connections: [fakeConnection({ isDefault: true })],
        bots: [fakeBot("bot-1", "Research")],
      }),
    );

    await render(<ConnectionsScreen {...props} />);
    await click("Disconnect");

    expect(container.textContent).toContain("This is the space default.");
    expect(container.textContent).toContain(
      "1 bot will have no model until another default is chosen.",
    );

    const confirm = [
      ...container.querySelectorAll<HTMLButtonElement>(".connection .memory-form button"),
    ].find((button) => button.textContent === "Disconnect");

    await act(async () => {
      confirm?.click();
    });

    expect(props.onDisconnect).toHaveBeenCalledWith("connection-1");
  });
});

describe("the bot assignments", () => {
  it("distinguishes a follower from an override and writes a change", async () => {
    const props = screenProps(
      state({
        connections: [fakeConnection()],
        bots: [
          fakeBot("bot-1", "Research"),
          { ...fakeBot("bot-2", "Writer"), modelConnectionId: "connection-1" },
        ],
      }),
    );

    await render(<ConnectionsScreen {...props} />);

    const selects = [...container.querySelectorAll("select")];

    expect(selects.map((select) => (select as HTMLSelectElement).value)).toEqual([
      "",
      "connection-1",
    ]);

    await act(async () => {
      const first = selects[0] as HTMLSelectElement;
      first.value = "connection-1";
      first.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(props.onSetBotConnection).toHaveBeenCalledWith("bot-1", "connection-1");
  });
});

describe("creating a connection", () => {
  it("collects the endpoint and the key and submits them", async () => {
    const props = screenProps(state({ credentials: [fakeCredential()] }));

    await render(<ConnectionsScreen {...props} />);
    await click("New connection");

    const inputs = [...container.querySelectorAll("input")];

    await act(async () => {
      const [label, baseUrl, credentialName, credentialValue, defaultModel] = inputs;

      if (
        label === undefined ||
        baseUrl === undefined ||
        credentialName === undefined ||
        credentialValue === undefined ||
        defaultModel === undefined
      ) {
        throw new Error("the create form did not render its fields");
      }

      setValue(label, "Local models");
      setValue(baseUrl, "https://models.example.invalid/v1");
      setValue(credentialName, "model-key");
      setValue(credentialValue, "");
      setValue(defaultModel, "fixture-model");
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
    });

    expect(props.onCreate).toHaveBeenCalledWith({
      label: "Local models",
      baseUrl: "https://models.example.invalid/v1",
      credentialName: "model-key",
      credentialValue: "",
      defaultModel: "fixture-model",
    });
  });

  it("confirms a value under a stored name as a rotate before it writes", async () => {
    const props = screenProps(state({ credentials: [fakeCredential()] }));

    await render(<ConnectionsScreen {...props} />);
    await click("New connection");

    const inputs = [...container.querySelectorAll("input")];

    await act(async () => {
      const [label, baseUrl, credentialName, credentialValue] = inputs;

      if (
        label === undefined ||
        baseUrl === undefined ||
        credentialName === undefined ||
        credentialValue === undefined
      ) {
        throw new Error("the create form did not render its fields");
      }

      setValue(label, "Local models");
      setValue(baseUrl, "https://models.example.invalid/v1");
      setValue(credentialName, "model-key");
      setValue(credentialValue, "sk-live-0123456789abcdef");
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
    });

    // The first submit only arms the confirmation; the rotate writes on the
    // second, and the sentence names the value it replaces.
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "A key named model-key is already stored. Storing now replaces it; connections that use it send the new key from their next request.",
    );

    await click("Replace key");

    expect(props.onCreate).toHaveBeenCalledWith({
      label: "Local models",
      baseUrl: "https://models.example.invalid/v1",
      credentialName: "model-key",
      credentialValue: "sk-live-0123456789abcdef",
      defaultModel: "",
    });
  });
});

/** Sets a controlled input's value the way React's onChange reads it. */
function setValue(input: Element, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
