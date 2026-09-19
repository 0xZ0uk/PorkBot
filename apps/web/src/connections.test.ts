import type { ModelConnection } from "@porkbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { createConnectionsController } from "./connections.ts";
import type {
  ConnectionsController,
  ConnectionsState,
  ConnectionsTransport,
} from "./connections.ts";
import {
  fakeBot,
  fakeConnection,
  fakeCredential,
  fakeProbe,
  scriptedConnectionsTransport,
} from "../test/fakes.ts";

/**
 * The connections controller without a DOM: the read, the probe and the write
 * rules the screen depends on. The tests pin what a person observes — a
 * connection list with the store's masks, a probe's own answer, the impact
 * sentence a revoke or a disconnect earns, and the order a create takes (the
 * key first, the connection second) — rather than the transport's shape.
 */

async function until(
  controller: ConnectionsController,
  predicate: (state: ConnectionsState) => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate(controller.state())) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`timed out waiting for ${label}`);
}

function loaded(transport: ConnectionsTransport): { readonly controller: ConnectionsController } {
  const controller = createConnectionsController({ transport });
  controller.load();

  return { controller };
}

describe("loading the screen", () => {
  it("reads connections, stored keys and bots in one pass", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection({ isDefault: true })],
      credentials: [fakeCredential()],
      bots: [fakeBot("bot-1", "Research")],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    expect(controller.state().connections).toHaveLength(1);
    expect(controller.state().credentials).toHaveLength(1);
    expect(controller.state().bots.map((bot) => bot.name)).toEqual(["Research"]);
  });

  it("shows a refusal sentence when the list cannot be read", async () => {
    const transport = scriptedConnectionsTransport({ listFailure: new Error("unreachable") });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "refused", "the refusal");
    expect(controller.state().refusal).toBe("Connections could not be loaded.");
  });

  it("does not let a superseded load replace a newer answer", async () => {
    let releaseFirst: (connections: readonly ModelConnection[]) => void = () => undefined;
    const first = new Promise<readonly ModelConnection[]>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const base = scriptedConnectionsTransport({ connections: [fakeConnection()] });
    const transport: ConnectionsTransport = {
      ...base,
      listConnections: async () => {
        calls += 1;

        return calls === 1 ? first : [fakeConnection({ id: "connection-new" })];
      },
    };
    const controller = createConnectionsController({ transport });

    controller.load();
    controller.load();

    await until(
      controller,
      (state) => state.connections[0]?.id === "connection-new",
      "the newer list",
    );

    releaseFirst([fakeConnection({ id: "connection-old" })]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(controller.state().connections[0]?.id).toBe("connection-new");
  });
});

describe("probing", () => {
  it("keeps the probe's own answer, streaming unsupported included", async () => {
    const probe = fakeProbe({ streaming: false, models: [{ id: "fixture-model" }] });
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection()],
      probe,
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.probe("connection-1");

    expect(controller.state().probes["connection-1"]).toEqual({ status: "answered", probe });
    expect(controller.state().pending).toBeNull();
  });

  it("marks a probe the transport could not complete as failed", async () => {
    const base = scriptedConnectionsTransport({ connections: [fakeConnection()] });
    const transport: ConnectionsTransport = {
      ...base,
      probeConnection: async () => {
        throw new Error("socket closed");
      },
    };
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.probe("connection-1");

    expect(controller.state().probes["connection-1"]).toEqual({ status: "failed" });
  });
});

describe("choosing the default", () => {
  it("swaps the default and says which connection holds it", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [
        fakeConnection({ id: "connection-a", label: "Local models" }),
        fakeConnection({ id: "connection-b", label: "Hosted", isDefault: true }),
      ],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.setDefault("connection-a");

    expect(controller.state().notice?.text).toBe("Local models is now the space default.");
    expect(
      controller.state().connections.find((connection) => connection.id === "connection-a")
        ?.isDefault,
    ).toBe(true);
    expect(
      controller.state().connections.find((connection) => connection.id === "connection-b")
        ?.isDefault,
    ).toBe(false);
  });
});

describe("disconnecting", () => {
  const selected = {
    ...fakeBot("bot-1", "Research"),
    modelConnectionId: "connection-1",
  };
  const follower = fakeBot("bot-2", "Writer");

  it("reports the bots that fall back to the space default", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection()],
      bots: [selected, follower],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.disconnect("connection-1");

    expect(controller.state().notice?.text).toBe(
      "Disconnected Local models. 1 bot falls back to the space default.",
    );
    expect(controller.state().connections).toEqual([]);
  });

  it("reports when the disconnected connection was the space default", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection({ isDefault: true })],
      bots: [follower],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.disconnect("connection-1");

    expect(controller.state().notice?.text).toBe(
      "Disconnected Local models. 1 bot now has no model until another default is chosen.",
    );
  });

  it("says so when no bot had selected it", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection()],
      bots: [follower],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.disconnect("connection-1");

    expect(controller.state().notice?.text).toBe("Disconnected Local models. No bot selected it.");
  });
});

describe("revoking a key", () => {
  const selected = {
    ...fakeBot("bot-1", "Research"),
    modelConnectionId: "connection-1",
  };
  const follower = fakeBot("bot-2", "Writer");

  it("reports the connections and bots the revocation takes down", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection({ isDefault: true })],
      credentials: [fakeCredential()],
      bots: [selected, follower],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.revoke("model-key");

    expect(controller.state().notice?.text).toBe(
      "Revoked model-key. Local models has no key; 2 bots lose their model until one is stored.",
    );
    expect(controller.state().credentials).toEqual([]);
  });

  it("reports a key no connection uses", async () => {
    const transport = scriptedConnectionsTransport({ credentials: [fakeCredential()] });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.revoke("model-key");

    expect(controller.state().notice?.text).toBe("Revoked model-key. No connection used it.");
  });

  it("reports a connection left without a key when no bot is affected", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection()],
      credentials: [fakeCredential()],
      bots: [follower],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.revoke("model-key");

    expect(controller.state().notice?.text).toBe("Revoked model-key. Local models has no key.");
  });

  it("shows an error notice and keeps the list when the write fails", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection()],
      credentials: [fakeCredential()],
      writeFailure: new Error("refused"),
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.revoke("model-key");

    expect(controller.state().notice?.kind).toBe("error");
    expect(controller.state().credentials).toHaveLength(1);
  });
});

describe("connecting", () => {
  it("stores the key first and creates the connection second", async () => {
    const base = scriptedConnectionsTransport();
    const storeCredential = vi.fn(base.storeCredential);
    const createConnection = vi.fn(base.createConnection);
    const { controller } = loaded({ ...base, storeCredential, createConnection });

    await until(controller, (state) => state.status === "ready", "the list");
    const created = await controller.create({
      label: "Local models",
      baseUrl: "https://models.example.invalid/v1",
      credentialName: "model-key",
      defaultModel: "",
      credentialValue: "sk-test",
    });

    expect(created).toBe(true);
    expect(storeCredential).toHaveBeenCalledWith({ name: "model-key", value: "sk-test" });
    expect(createConnection).toHaveBeenCalledWith({
      label: "Local models",
      baseUrl: "https://models.example.invalid/v1",
      credentialName: "model-key",
      defaultModel: null,
    });
    expect(storeCredential.mock.invocationCallOrder[0]).toBeLessThan(
      createConnection.mock.invocationCallOrder[0] ?? 0,
    );
    expect(controller.state().notice?.text).toBe("Connected Local models.");
  });

  it("says the key was stored when the connection could not be created", async () => {
    const base = scriptedConnectionsTransport();
    const transport: ConnectionsTransport = {
      ...base,
      createConnection: async () => {
        throw new Error("the label is taken");
      },
    };
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    const created = await controller.create({
      label: "Local models",
      baseUrl: "https://models.example.invalid/v1",
      credentialName: "model-key",
      defaultModel: "",
      credentialValue: "sk-test",
    });

    expect(created).toBe(false);
    expect(controller.state().notice).toEqual({
      kind: "error",
      text: "The key was stored, but the connection was not created.",
    });
    expect(controller.state().credentials).toHaveLength(1);
  });

  it("reuses a stored key when the value is blank", async () => {
    const base = scriptedConnectionsTransport({ credentials: [fakeCredential()] });
    const storeCredential = vi.fn(base.storeCredential);
    const { controller } = loaded({ ...base, storeCredential });

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.create({
      label: "Local models",
      baseUrl: "https://models.example.invalid/v1",
      credentialName: "model-key",
      defaultModel: "fixture-model",
      credentialValue: "",
    });

    expect(storeCredential).not.toHaveBeenCalled();
    expect(controller.state().notice?.text).toBe("Connected Local models.");
  });
});

describe("assigning a bot", () => {
  it("switches a bot between a connection and the space default", async () => {
    const transport = scriptedConnectionsTransport({
      connections: [fakeConnection()],
      bots: [fakeBot("bot-1", "Research")],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    await controller.setBotConnection("bot-1", "connection-1");

    expect(controller.state().notice?.text).toBe("Research now uses Local models.");
    expect(controller.state().bots[0]?.modelConnectionId).toBe("connection-1");

    await controller.setBotConnection("bot-1", null);

    expect(controller.state().notice?.text).toBe("Research now follows the space default.");
    expect(controller.state().bots[0]?.modelConnectionId).toBeNull();
  });
});
