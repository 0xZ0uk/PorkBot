import type { Server } from "node:http";
import {
  ComputerEmulator,
  createSupervisorComputerProvider,
  DEFAULT_COMPUTER_HOME,
} from "@porkbot/adapters";
import {
  computerConformance,
  CONFORMANCE_MISSING_URL,
  CONFORMANCE_PAGE_TEXT,
  CONFORMANCE_PAGE_TITLE,
  CONFORMANCE_PAGE_URL,
  CONFORMANCE_UNSCRIPTED_SELECTOR,
} from "@porkbot/adapters";
import type { ComputerConformanceHarness } from "@porkbot/adapters";
import { createScreenCapabilityCodec } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createComputerLifecycle } from "./computer-lifecycle.ts";
import { createSupervisorServer } from "./server.ts";

/**
 * The supervisor boundary end to end, in-process: the real server, the real
 * client and the real emulator behind them, over a real loopback socket.
 *
 * The conformance suite is the important half. It is the same suite every
 * provider is held to, and running it through the transport proves the wire
 * carries the whole seam — idempotent boot, command results and budgets,
 * classification, snapshots, lists — rather than testing the client and the
 * server against separate ideas of the protocol. The tests after it pin what
 * only this boundary has: the service token, the protocol version, the body
 * cap, and the reserved screen paths' capability gate.
 */

const serviceToken = "supervisor-service-token";
const screenKey = "screen-capability-key";
const proxyKey = "proxy-capability-key";
const serviceName = "@porkbot/supervisor";

const lines: string[] = [];
const logger: Logger = createLogger({
  service: serviceName,
  write: (line) => lines.push(line),
});

const emulator = new ComputerEmulator({ proxy: { tokenSecret: proxyKey } });
emulator
  .servePage({
    url: CONFORMANCE_PAGE_URL,
    title: CONFORMANCE_PAGE_TITLE,
    text: CONFORMANCE_PAGE_TEXT,
  })
  .serveBrowserAction({
    url: CONFORMANCE_PAGE_URL,
    selector: "#next",
    action: "click",
    target: CONFORMANCE_MISSING_URL,
  });

const server: Server = createSupervisorServer({
  lifecycle: createComputerLifecycle({ provider: emulator }),
  serviceToken,
  screenTokens: createScreenCapabilityCodec(screenKey),
  logger,
  serviceName,
  maxBodyBytes: 512,
});

let origin = "";
let harnessCounter = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("the supervisor test server did not bind a TCP port");
  }

  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function client() {
  return createSupervisorComputerProvider({ baseUrl: origin, token: serviceToken });
}

async function createConformanceHarness(): Promise<ComputerConformanceHarness> {
  harnessCounter += 1;
  const base = harnessCounter * 10;

  return {
    provider: client(),
    computer: { computerId: `computer-${base}`, botId: `bot-${base}` },
    otherComputer: { computerId: `computer-${base + 1}`, botId: `bot-${base + 1}` },
    home: DEFAULT_COMPUTER_HOME,
    timeoutMs: 25,
    slowCommand: "sleep 5",
    browser: {
      pageUrl: CONFORMANCE_PAGE_URL,
      pageTitle: CONFORMANCE_PAGE_TITLE,
      pageText: CONFORMANCE_PAGE_TEXT,
      missingUrl: CONFORMANCE_MISSING_URL,
      unscriptedSelector: CONFORMANCE_UNSCRIPTED_SELECTOR,
    },
  };
}

await computerConformance("supervisor transport", createConformanceHarness);

/** A raw call with the service headers, for the refusals the client would hide. */
function rawCall(
  path: string,
  options: {
    readonly token?: string | null;
    readonly protocol?: string | null;
    readonly body?: string;
    readonly screen?: string | null;
    readonly method?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-porkbot-supervisor-protocol": "protocol" in options ? (options.protocol ?? "") : "1",
  };
  const token =
    "screen" in options ? options.screen : "token" in options ? options.token : serviceToken;

  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }

  return fetch(`${origin}${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

describe("the supervisor surface's own refusals", () => {
  it("answers the health probe without any credential", async () => {
    const response = await fetch(`${origin}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", service: serviceName });
  });

  it("refuses a lifecycle call with no token, a wrong token or no protocol version", async () => {
    const missing = await rawCall("/v1/computers/status", { token: null });
    const wrong = await rawCall("/v1/computers/status", { token: "not-the-token" });
    const unversioned = await rawCall("/v1/computers/status", { protocol: null });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ error: { kind: "unauthorized" } });
    expect(unversioned.status).toBe(400);
  });

  it("refuses an oversized body before it is parsed and a malformed body before a handler", async () => {
    const oversized = await rawCall("/v1/computers/status", {
      body: JSON.stringify({ computer: { computerId: "x".repeat(600), botId: "bot" } }),
    });
    const malformed = await rawCall("/v1/computers/status", { body: "this is not json" });
    const shape = await rawCall("/v1/computers/status", { body: JSON.stringify({ computer: {} }) });

    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: { kind: "too_large" } });
    expect(malformed.status).toBe(400);
    expect(shape.status).toBe(400);
  });

  it("answers an unknown route as not_found", async () => {
    const response = await rawCall("/v1/computers/nonsense");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "not_found" } });
  });

  it("keeps the provider's vocabulary on the wire when a call is classified", async () => {
    const response = await rawCall("/v1/computers/exec", {
      body: JSON.stringify({
        computer: { computerId: "never-provisioned", botId: "bot-1" },
        command: "printf hello",
        timeoutMs: 1_000,
      }),
    });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "gone" } });

    const raised = await client()
      .exec({
        computer: { computerId: "never-provisioned", botId: "bot-1" },
        command: "printf hello",
        timeoutMs: 1_000,
      })
      .catch((error: unknown) => error);

    expect(raised).toMatchObject({ name: "ComputerProviderError", kind: "gone" });
  });

  it("carries the per-bot provider selection across the wire unchanged", async () => {
    const ref = { computerId: "provider-carried", botId: "bot-carried", provider: "offline" };

    await expect(client().ensure(ref)).resolves.toMatchObject({ computer: ref, state: "running" });
    await expect(client().status(ref)).resolves.toMatchObject({ computer: ref });
  });

  it("refuses a blank provider kind before a handler sees it", async () => {
    const response = await rawCall("/v1/computers/status", {
      body: JSON.stringify({
        computer: { computerId: "blank-provider", botId: "bot-1", provider: "  " },
      }),
    });

    expect(response.status).toBe(400);
  });

  it("refuses a command whose budget is beyond what the supervisor will hold open", async () => {
    const response = await rawCall("/v1/computers/exec", {
      body: JSON.stringify({
        computer: { computerId: "raw-2", botId: "raw-bot" },
        command: "printf hello",
        timeoutMs: 3_600_000,
      }),
    });

    expect(response.status).toBe(400);
  });

  it("carries a bounded per-command environment and refuses an unbounded one", async () => {
    const ref = { computerId: "env-carried", botId: "bot-env" };
    await client().ensure(ref);

    const accepted = await rawCall("/v1/computers/exec", {
      body: JSON.stringify({
        computer: ref,
        command: "printf hello",
        timeoutMs: 1_000,
        environment: { PORKBOT_PROXY_URL: "http://proxy:8321" },
      }),
    });

    expect(accepted.status).toBe(200);

    // An oversized value is refused by the body cap before a handler runs; a
    // non-string value and an over-long name reach the handler and are refused
    // by the environment rule. Either way the command never runs.
    const oversizedValue = await rawCall("/v1/computers/exec", {
      body: JSON.stringify({
        computer: ref,
        command: "printf hello",
        timeoutMs: 1_000,
        environment: { PORKBOT_PROXY_TOKEN: "x".repeat(9_000) },
      }),
    });
    const nonString = await rawCall("/v1/computers/exec", {
      body: JSON.stringify({
        computer: ref,
        command: "printf hello",
        timeoutMs: 1_000,
        environment: { PORKBOT_PROXY_TOKEN: 42 },
      }),
    });
    const longName = await rawCall("/v1/computers/exec", {
      body: JSON.stringify({
        computer: ref,
        command: "printf hello",
        timeoutMs: 1_000,
        environment: { ["x".repeat(200)]: "value" },
      }),
    });

    expect(oversizedValue.status).toBe(413);
    expect(nonString.status).toBe(400);
    expect(longName.status).toBe(400);
  });
});

describe("the credential-proxy routes", () => {
  const ref = { computerId: "proxy-carried", botId: "bot-proxy" };
  const grant = {
    runId: "run-1",
    expiresAtSeconds: 4_102_444_800,
    upstreams: [
      {
        name: "model",
        origin: "https://api.model.example",
        headers: { authorization: "Bearer sk-marker" },
      },
    ],
  };

  it("grants through the client and answers the endpoint", async () => {
    await client().ensure(ref);

    const endpoint = await client().proxy?.grant(ref, grant);

    expect(endpoint?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(client().proxy?.endpoint(ref)).resolves.toEqual(endpoint);

    await client().proxy?.revoke(ref, "run-1");
  });

  it("refuses a grant with a plaintext or credentialed origin before a handler sees it", async () => {
    await client().ensure(ref);

    const plaintext = await rawCall("/v1/computers/proxy/grant", {
      body: JSON.stringify({
        computer: ref,
        grant: {
          ...grant,
          upstreams: [{ name: "model", origin: "http://insecure.example" }],
        },
      }),
    });
    const credentialed = await rawCall("/v1/computers/proxy/grant", {
      body: JSON.stringify({
        computer: ref,
        grant: {
          ...grant,
          upstreams: [{ name: "model", origin: "https://user:pass@api.model.example" }],
        },
      }),
    });
    const pathed = await rawCall("/v1/computers/proxy/grant", {
      body: JSON.stringify({
        computer: ref,
        grant: {
          ...grant,
          upstreams: [{ name: "model", origin: "https://api.model.example/v1" }],
        },
      }),
    });

    expect(plaintext.status).toBe(400);
    expect(credentialed.status).toBe(400);
    expect(pathed.status).toBe(400);
  });

  it("refuses a grant that injects a framing header, on the wire and at the client", async () => {
    await client().ensure(ref);

    const response = await rawCall("/v1/computers/proxy/grant", {
      body: JSON.stringify({
        computer: ref,
        grant: {
          ...grant,
          upstreams: [
            {
              name: "model",
              origin: "https://api.model.example",
              headers: { host: "elsewhere.example", authorization: "Bearer sk-marker" },
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(
      client().proxy?.grant(ref, {
        ...grant,
        upstreams: [
          {
            name: "model",
            origin: "https://api.model.example",
            headers: { "content-length": "0" },
          },
        ],
      }),
    ).rejects.toThrow(/refused .* with status 400/);
  });

  it("answers a deployment with no proxy as the shared not_found", async () => {
    const bare = createSupervisorServer({
      lifecycle: createComputerLifecycle({ provider: new ComputerEmulator() }),
      serviceToken,
      logger,
      serviceName,
    });
    await new Promise<void>((resolve) => {
      bare.listen(0, "127.0.0.1", resolve);
    });
    const address = bare.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    const bareClient = createSupervisorComputerProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      token: serviceToken,
    });

    try {
      await expect(bareClient.proxy?.grant(ref, grant)).rejects.toMatchObject({
        kind: "not_found",
      });
      await expect(bareClient.proxy?.endpoint(ref)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => {
        bare.close(() => resolve());
      });
    }
  });
});

describe("the reserved screen paths", () => {
  function capabilityFor(computerId: string): string {
    return createScreenCapabilityCodec(screenKey).mint({
      computerId,
      botId: "bot-1",
      spaceId: "space-1",
      userId: "user-1",
    });
  }

  it("refuses a screen call with no capability or a forged one", async () => {
    const missing = await rawCall("/v1/computers/screen-1/frames", {
      screen: null,
      method: "GET",
    });
    const forged = await rawCall("/v1/computers/screen-1/frames", {
      screen: capabilityFor("screen-1") + "x",
      method: "GET",
    });

    expect(missing.status).toBe(401);
    expect(forged.status).toBe(401);
  });

  it("refuses a valid capability that names another computer", async () => {
    const response = await rawCall("/v1/computers/screen-2/frames", {
      screen: capabilityFor("screen-1"),
      method: "GET",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "forbidden" } });
  });

  it("refuses an expired capability even when its signature is right", async () => {
    const expired = createScreenCapabilityCodec(screenKey, { nowSeconds: () => 0 }).mint(
      { computerId: "screen-3", botId: "bot-1", spaceId: "space-1", userId: "user-1" },
      1,
    );
    const response = await rawCall("/v1/computers/screen-3/frames", {
      screen: expired,
      method: "GET",
    });

    expect(response.status).toBe(401);
  });

  it("lets a valid capability through the gate to the deliberate v1.1 refusal", async () => {
    const response = await rawCall("/v1/computers/screen-4/frames", {
      screen: capabilityFor("screen-4"),
      method: "GET",
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: "not_implemented" } });
  });
});
