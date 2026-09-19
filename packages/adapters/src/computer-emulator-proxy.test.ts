import { isProviderFailure } from "@porkbot/adapter-kit";
import type { ComputerProxyGrant, ProviderFailure } from "@porkbot/adapter-kit";
import type { SafeFetch } from "@porkbot/effect";
import { createProxyCapabilityCodec } from "@porkbot/effect";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerEmulator } from "./computer-emulator.ts";
import { proxyTokenHeader } from "./credential-proxy.ts";

/**
 * The emulated computer's credential proxy (slice 7.8).
 *
 * The proxy is the shipped server, not a stub: these tests grant a real grant
 * through the seam, call the proxy over loopback exactly as a command in the
 * sandbox would, and observe what crossed the upstream leg — the credential
 * the proxy injected and the headers the sandbox's request carried. Binding,
 * revocation and stop semantics are asserted through the same wire.
 */

const computer = { computerId: "computer-1", botId: "bot-1" };
const otherComputer = { computerId: "computer-2", botId: "bot-2" };
const secret = "emulator-proxy-test-secret";
const marker = "sk-emulator-marker";

interface RecordedCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

const running: ComputerEmulator[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (emulator) => emulator.close()));
});

function emulatorWithProxy(calls: RecordedCall[]): ComputerEmulator {
  const upstream: SafeFetch = async (url, init) => {
    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }

    calls.push({ url: url.toString(), headers });

    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const emulator = new ComputerEmulator({
    proxy: { tokenSecret: secret, fetch: upstream },
  });

  running.push(emulator);
  return emulator;
}

function grant(overrides: Partial<ComputerProxyGrant> = {}): ComputerProxyGrant {
  return {
    runId: "run-1",
    expiresAtSeconds: Math.floor(Date.now() / 1_000) + 3_600,
    upstreams: [
      {
        name: "model",
        origin: "https://api.model.example",
        headers: { authorization: `Bearer ${marker}` },
      },
    ],
    ...overrides,
  };
}

function token(binding: { runId?: string; computerId?: string; botId?: string } = {}): string {
  return createProxyCapabilityCodec(secret).mint({
    runId: binding.runId ?? "run-1",
    computerId: binding.computerId ?? computer.computerId,
    botId: binding.botId ?? computer.botId,
  });
}

async function call(url: string, bearer: string, path = "/u/model/v1/models"): Promise<Response> {
  return await fetch(`${url}${path}`, { headers: { [proxyTokenHeader]: bearer } });
}

describe("the emulated computer's credential proxy", () => {
  it("grants, forwards with the injected credential and revokes on request", async () => {
    const calls: RecordedCall[] = [];
    const emulator = emulatorWithProxy(calls);
    const proxy = emulator.proxy;

    expect(proxy).toBeDefined();
    await emulator.ensure(computer);

    const endpoint = await proxy?.grant(computer, grant());

    expect(endpoint?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const allowed = await call(endpoint?.url ?? "", token());

    expect(allowed.status).toBe(200);
    expect(calls).toEqual([
      {
        url: "https://api.model.example/v1/models",
        headers: expect.objectContaining({ authorization: `Bearer ${marker}` }),
      },
    ]);

    await proxy?.revoke(computer, "run-1");

    expect((await call(endpoint?.url ?? "", token())).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("refuses a token for another computer even when the run id matches", async () => {
    const calls: RecordedCall[] = [];
    const emulator = emulatorWithProxy(calls);
    await emulator.ensure(computer);
    const endpoint = await emulator.proxy?.grant(computer, grant());

    const foreign = token({ computerId: otherComputer.computerId, botId: otherComputer.botId });
    const response = await call(endpoint?.url ?? "", foreign);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "capability_binding" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a valid token whose run holds no grant here", async () => {
    const calls: RecordedCall[] = [];
    const emulator = emulatorWithProxy(calls);
    await emulator.ensure(computer);
    const endpoint = await emulator.proxy?.grant(computer, grant());

    const otherRun = token({ runId: "run-other" });
    const response = await call(endpoint?.url ?? "", otherRun);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_grant" });
    expect(calls).toHaveLength(0);
  });

  it("answers absent for a stopped machine and refuses a grant for one", async () => {
    const emulator = emulatorWithProxy([]);

    await expect(emulator.proxy?.endpoint(computer)).resolves.toBeUndefined();
    await emulator.ensure(computer);
    await expect(emulator.proxy?.endpoint(computer)).resolves.toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });

    await emulator.stop(computer);
    await expect(emulator.proxy?.endpoint(computer)).resolves.toBeUndefined();

    try {
      await emulator.proxy?.grant(computer, grant());
      throw new Error("expected the grant to be refused");
    } catch (error) {
      expect(isProviderFailure(error)).toBe(true);
      expect((error as ProviderFailure).kind).toBe("gone");
    }
  });
});
