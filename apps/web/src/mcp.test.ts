import { describe, expect, it } from "vitest";
import {
  createMcpController,
  liveGrants,
  removeOutcome,
  removeWarning,
  revokeWarning,
  serverStatusLabel,
} from "./mcp.ts";
import type { McpController, McpState } from "./mcp.ts";
import { fakeBot, fakeMcpServerDetail, fakeMcpTool, scriptedMcpTransport } from "../test/fakes.ts";

/**
 * The MCP controller without a DOM: the list read, the install (with and
 * without consent), the grants, the uninstall and both failure directions.
 *
 * The sentences under test are the confirmations the acceptance criteria name:
 * an uninstall states how many tools and bots it takes down, and a grant
 * revoke states what the bot loses and when. The controller also has to keep
 * the consent URL across a re-read, because the operator finishes OAuth in
 * another tab and comes back to a screen that must still know where it was.
 */

async function until(
  controller: McpController,
  predicate: (state: McpState) => boolean,
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

const server = fakeMcpServerDetail({
  id: "server-1",
  name: "Fixture server",
  tools: [fakeMcpTool()],
});

describe("the MCP controller", () => {
  it("lists the installed servers and the active bots", async () => {
    const controller = createMcpController({
      transport: scriptedMcpTransport({
        servers: [server],
        bots: [fakeBot("bot-1", "Ada")],
      }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");

    expect(controller.state().servers.map((candidate) => candidate.name)).toEqual([
      "Fixture server",
    ]);
    expect(controller.state().bots.map((bot) => bot.name)).toEqual(["Ada"]);
  });

  it("opens a server's detail and its grants, and closes again", async () => {
    const controller = createMcpController({
      transport: scriptedMcpTransport({ servers: [server], grants: { "server-1": ["bot-1"] } }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.open("server-1");

    expect(controller.state().selected?.id).toBe("server-1");
    expect(liveGrants(controller.state().grants)).toHaveLength(1);

    controller.close();
    expect(controller.state().selected).toBeNull();
  });

  it("installs a server that needs no consent and shows it ready", async () => {
    const controller = createMcpController({ transport: scriptedMcpTransport() });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");

    const installed = await controller.install({
      name: "Fixture",
      url: "https://mcp.example.invalid/mcp",
      auth: "none",
    });

    expect(installed).toBe(true);
    expect(controller.state().consent).toBeNull();
    expect(controller.state().selected?.status).toBe("ready");
    expect(controller.state().notice?.text).toBe("Installed Fixture.");
  });

  it("keeps the consent URL across a re-read until the server is authorized", async () => {
    const controller = createMcpController({
      transport: scriptedMcpTransport({
        authorizationUrl: "https://auth.example.invalid/consent",
      }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.install({
      name: "OAuth server",
      url: "https://mcp.example.invalid/mcp",
      auth: "oauth",
      clientId: "client-1",
    });

    expect(controller.state().consent).toEqual({
      serverId: "server-1",
      url: "https://auth.example.invalid/consent",
    });
    expect(controller.state().selected?.status).toBe("pending_authorization");
    expect(controller.state().notice?.text).toBe("Installed OAuth server. Authorize it to finish.");

    await controller.recheck();

    expect(controller.state().consent).toEqual({
      serverId: "server-1",
      url: "https://auth.example.invalid/consent",
    });
  });

  it("keeps the consent link when the detail is closed and reopened", async () => {
    const controller = createMcpController({
      transport: scriptedMcpTransport({
        authorizationUrl: "https://auth.example.invalid/consent",
      }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.install({
      name: "OAuth server",
      url: "https://mcp.example.invalid/mcp",
      auth: "oauth",
      clientId: "client-1",
    });

    controller.close();

    expect(controller.state().consent?.url).toBe("https://auth.example.invalid/consent");

    await controller.open("server-1");

    expect(controller.state().consent?.serverId).toBe("server-1");
    expect(controller.state().selected?.id).toBe("server-1");
  });

  it("grants a server to a bot and revokes it with a sentence", async () => {
    const controller = createMcpController({
      transport: scriptedMcpTransport({ servers: [server], bots: [fakeBot("bot-1", "Ada")] }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.open("server-1");
    await controller.grant("bot-1");

    expect(controller.state().notice?.text).toBe("Granted Fixture server to Ada.");
    expect(liveGrants(controller.state().grants).map((grant) => grant.botId)).toEqual(["bot-1"]);

    await controller.revokeGrant("bot-1");

    expect(controller.state().notice?.text).toBe("Ada loses Fixture server on its next call.");
    expect(liveGrants(controller.state().grants)).toEqual([]);
  });

  it("uninstalls a server, closes its detail and states what went away", async () => {
    const controller = createMcpController({
      transport: scriptedMcpTransport({
        servers: [server],
        grants: { "server-1": ["bot-1", "bot-2"] },
      }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.open("server-1");
    await controller.remove("server-1");

    expect(controller.state().servers).toEqual([]);
    expect(controller.state().selected).toBeNull();
    expect(controller.state().notice?.text).toBe(
      "Removed Fixture server. 1 tool and its stored credential are gone; 2 bots lost access.",
    );
  });

  it("keeps the detail open when the uninstall fails", async () => {
    const controller = createMcpController({
      transport: scriptedMcpTransport({
        servers: [server],
        writeFailure: new Error("offline"),
      }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.open("server-1");
    await controller.remove("server-1");

    expect(controller.state().selected?.id).toBe("server-1");
    expect(controller.state().notice).toEqual({
      kind: "error",
      text: "The change could not be saved.",
    });
  });

  it("refuses with one sentence when the list read fails", async () => {
    const controller = createMcpController({
      transport: scriptedMcpTransport({ listFailure: new Error("offline") }),
    });

    controller.load();
    await until(controller, (state) => state.status === "refused", "the refusal");
    expect(controller.state().refusal).toBe("MCP servers could not be loaded.");
  });

  it("states a removal's consequence before the write", () => {
    expect(removeWarning(server, [{ botId: "bot-1", revokedAt: null }])).toBe(
      "Removing Fixture server deletes 1 tool and its stored credential; 1 bot loses access.",
    );
    expect(
      removeOutcome(server, [
        { botId: "bot-1", revokedAt: null },
        { botId: "bot-2", revokedAt: null },
      ]),
    ).toBe(
      "Removed Fixture server. 1 tool and its stored credential are gone; 2 bots lost access.",
    );
    expect(revokeWarning("Ada")).toBe("Ada loses this server's tools on its next call.");
    expect(serverStatusLabel("pending_authorization")).toBe("Awaiting authorization");
    expect(serverStatusLabel("error")).toBe("Failed");
  });
});
