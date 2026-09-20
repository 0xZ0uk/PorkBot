import { describe, expect, it } from "vitest";
import {
  authLabel,
  createSecretsController,
  forgetOutcome,
  forgetWarning,
  secretStatusLabel,
} from "./secrets.ts";
import type { SecretsController, SecretsState } from "./secrets.ts";
import { fakeBot, fakeBotSecret, scriptedSecretsTransport } from "../test/fakes.ts";

/**
 * The secrets controller without a DOM: the bot scope, the store and the
 * forget, plus the sentences the confirmations show.
 *
 * Two rules are pinned here. Switching bots reads that bot's rows rather than
 * filtering the previous list, so a row cannot appear under the wrong bot; and
 * a forget says whether a value was actually cleared, because a retry that
 * found nothing is not a second deletion.
 */

async function until(
  controller: SecretsController,
  predicate: (state: SecretsState) => boolean,
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

function twoBots() {
  return scriptedSecretsTransport({
    bots: [fakeBot("bot-1", "Ada"), fakeBot("bot-2", "Grace")],
    secrets: {
      "bot-1": [fakeBotSecret({ name: "ada_token" })],
      "bot-2": [fakeBotSecret({ name: "grace_token" })],
    },
  });
}

describe("the secrets controller", () => {
  it("reads the first bot's rows by default", async () => {
    const controller = createSecretsController({ transport: twoBots() });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");

    expect(controller.state().selectedBotId).toBe("bot-1");
    expect(controller.state().secrets.map((secret) => secret.name)).toEqual(["ada_token"]);
  });

  it("reads the selected bot's rows instead of filtering the previous ones", async () => {
    const controller = createSecretsController({ transport: twoBots() });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.selectBot("bot-2");

    expect(controller.state().selectedBotId).toBe("bot-2");
    expect(controller.state().secrets.map((secret) => secret.name)).toEqual(["grace_token"]);
  });

  it("stores a value and re-reads the row without the value", async () => {
    const transport = scriptedSecretsTransport({ secrets: {} });
    const controller = createSecretsController({ transport });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");

    const stored = await controller.store({
      name: "api_token",
      value: "sk-live-0123456789abcdef",
      origin: "https://api.example.invalid",
      auth: { type: "bearer" },
    });

    expect(stored).toBe(true);
    expect(controller.state().notice).toEqual({ kind: "info", text: "Stored api_token." });
    expect(controller.state().secrets.map((secret) => secret.name)).toEqual(["api_token"]);
    expect(JSON.stringify(controller.state())).not.toContain("sk-live-0123456789abcdef");
  });

  it("forgets a stored value and says it was cleared", async () => {
    const controller = createSecretsController({ transport: twoBots() });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.forget("ada_token");

    expect(controller.state().notice).toEqual({
      kind: "info",
      text: "Forgot ada_token. The stored value was cleared.",
    });
    expect(controller.state().secrets[0]?.status).toBe("forgotten");
  });

  it("says a forget found nothing rather than implying a second clear", async () => {
    const controller = createSecretsController({
      transport: scriptedSecretsTransport({ bots: [fakeBot("bot-1", "Ada")], secrets: {} }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");
    await controller.forget("missing_token");

    expect(controller.state().notice).toEqual({
      kind: "info",
      text: "Forgot missing_token. No value was stored.",
    });
  });

  it("leaves the rows alone when a store fails", async () => {
    const controller = createSecretsController({
      transport: scriptedSecretsTransport({
        secrets: { "bot-1": [fakeBotSecret()] },
        writeFailure: new Error("offline"),
      }),
    });

    controller.load();
    await until(controller, (state) => state.status === "ready", "the read");

    const stored = await controller.store({
      name: "api_token",
      value: "sk-live-0123456789abcdef",
      origin: "https://api.example.invalid",
      auth: { type: "bearer" },
    });

    expect(stored).toBe(false);
    expect(controller.state().notice).toEqual({
      kind: "error",
      text: "The secret could not be stored.",
    });
    expect(controller.state().secrets).toHaveLength(1);
  });

  it("refuses with one sentence when the read fails", async () => {
    const controller = createSecretsController({
      transport: scriptedSecretsTransport({ listFailure: new Error("offline") }),
    });

    controller.load();
    await until(controller, (state) => state.status === "refused", "the refusal");
    expect(controller.state().refusal).toBe("Secrets could not be loaded.");
  });

  it("names what a forget costs and what a status means", () => {
    expect(forgetWarning("api_token")).toContain("clears the stored value now");
    expect(forgetOutcome("api_token", false)).toContain("No value was stored.");
    expect(secretStatusLabel("stored")).toBe("Stored");
    expect(secretStatusLabel("forgotten")).toBe("No value");
    expect(authLabel({ type: "bearer" })).toBe("Bearer token");
    expect(authLabel({ type: "header", name: "x-api-key" })).toBe("Header x-api-key");
    expect(authLabel({ type: "basic", username: "operator" })).toBe("Basic operator");
  });
});
