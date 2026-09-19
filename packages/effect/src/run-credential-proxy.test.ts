import type {
  ComputerProvider,
  ComputerProxyEndpoint,
  ComputerProxyGrant,
  ComputerRef,
  CredentialProxyAdmin,
  CredentialStore,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import type { BotSecretResolver } from "./bot-secrets.ts";
import { createProxyCapabilityCodec } from "./proxy-capability.ts";
import {
  createRunCredentialProxy,
  RUN_PROXY_TOKEN_ENV,
  RUN_PROXY_URL_ENV,
  RunProxyCredentialError,
  RunProxyUnavailableError,
} from "./run-credential-proxy.ts";

/**
 * The run-scoped grant (slice 7.8, PRD decision 29).
 *
 * The composition is exercised against a recording `CredentialProxyAdmin`, so
 * every assertion names exactly what the computer's proxy received: which
 * credential header was built from which store name, which deadline the run's
 * lease put on the grant, and that revocation is the run's own call. The
 * capability half is checked against the codec the proxy verifies with, so
 * binding and lifetime are proven on the token the sandbox would hold.
 */

const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };
const otherComputer: ComputerRef = { computerId: "computer-2", botId: "bot-2" };
const proxySecret = "run-proxy-test-secret";
const credentialName = "model-key";
const credentialValue = "sk-run-proxy-marker";

interface RecordingProxy extends CredentialProxyAdmin {
  readonly grants: ComputerProxyGrant[];
  readonly revoked: readonly { readonly computer: ComputerRef; readonly runId: string }[];
  failGrant?: Error | undefined;
}

function recordingProxy(url = "http://127.0.0.1:9999"): RecordingProxy {
  const grants: ComputerProxyGrant[] = [];
  const revoked: { computer: ComputerRef; runId: string }[] = [];
  const proxy: RecordingProxy = {
    grants,
    revoked,
    async grant(_computer, grant): Promise<ComputerProxyEndpoint> {
      if (proxy.failGrant !== undefined) {
        throw proxy.failGrant;
      }

      grants.push(grant);
      return { url };
    },
    async revoke(target, runId): Promise<void> {
      revoked.push({ computer: target, runId });
    },
    async endpoint(): Promise<ComputerProxyEndpoint | undefined> {
      return { url };
    },
  };

  return proxy;
}

/** The provider seam with only `proxy` interesting; everything else refuses loudly. */
/** The test's credential store: the same shape a database read implements, in memory. */
function credentialStore(entries: Iterable<readonly [string, string]> = []): CredentialStore {
  const secrets = new Map(entries);

  return { resolve: (name) => Promise.resolve(secrets.get(name)) };
}

function providerWith(proxy: CredentialProxyAdmin | undefined): ComputerProvider {
  const rejected = (): never => {
    throw new Error("this test's provider was asked for something it does not implement");
  };
  const base: ComputerProvider = {
    validate: async () => rejected(),
    ensure: async () => rejected(),
    status: async () => rejected(),
    stop: async () => rejected(),
    list: async () => rejected(),
    exec: async () => rejected(),
    snapshot: async () => rejected(),
    restore: async () => rejected(),
    destroy: async () => rejected(),
  };

  return proxy === undefined ? base : { ...base, proxy };
}

function runProxy(proxy: CredentialProxyAdmin | undefined) {
  const credentials = credentialStore([[credentialName, credentialValue]]);

  return {
    credentials,
    proxy: createRunCredentialProxy({
      provider: providerWith(proxy),
      credentials,
      tokenSecret: proxySecret,
    }),
  };
}

const openRequest = {
  computer,
  runId: "run-1",
  expiresAtSeconds: 4_102_444_800,
  upstreams: [{ name: "model", origin: "https://api.model.example", credentialName }],
} as const;

describe("the run-scoped credential proxy", () => {
  it("resolves a credential into the grant's injected header and returns a capability", async () => {
    const admin = recordingProxy();
    const { proxy } = runProxy(admin);
    const handle = await proxy.open(openRequest);

    expect(admin.grants).toHaveLength(1);
    expect(admin.grants[0]).toEqual({
      runId: "run-1",
      expiresAtSeconds: 4_102_444_800,
      upstreams: [
        {
          name: "model",
          origin: "https://api.model.example",
          headers: { authorization: `Bearer ${credentialValue}` },
        },
      ],
    });
    expect(handle.endpoint).toEqual({ url: "http://127.0.0.1:9999" });

    const environment = handle.environmentFor(30_000);
    expect(environment[RUN_PROXY_URL_ENV]).toBe("http://127.0.0.1:9999");

    const token = environment[RUN_PROXY_TOKEN_ENV] ?? "";
    const check = createProxyCapabilityCodec(proxySecret).verify(token, {
      runId: "run-1",
      computerId: computer.computerId,
      botId: computer.botId,
    });

    expect(check.valid).toBe(true);
    expect(JSON.stringify(environment)).not.toContain(credentialValue);
  });

  it("injects no header for a plan that names no credential", async () => {
    const admin = recordingProxy();
    const { proxy } = runProxy(admin);

    await proxy.open({
      ...openRequest,
      upstreams: [{ name: "registry", origin: "https://registry.example" }],
    });

    expect(admin.grants[0]?.upstreams).toEqual([
      { name: "registry", origin: "https://registry.example" },
    ]);
  });

  it("honours a custom header and scheme", async () => {
    const admin = recordingProxy();
    const credentials = credentialStore([[credentialName, credentialValue]]);
    const proxy = createRunCredentialProxy({
      provider: providerWith(admin),
      credentials,
      tokenSecret: proxySecret,
    });

    await proxy.open({
      ...openRequest,
      upstreams: [
        {
          name: "search",
          origin: "https://search.example",
          credentialName,
          header: "X-Api-Key",
          scheme: "",
        },
      ],
    });

    expect(admin.grants[0]?.upstreams[0]?.headers).toEqual({ "x-api-key": credentialValue });
  });

  it("refuses a provider without a proxy as the shared not_found", async () => {
    const { proxy } = runProxy(undefined);

    await expect(proxy.open(openRequest)).rejects.toBeInstanceOf(RunProxyUnavailableError);

    try {
      await proxy.open(openRequest);
    } catch (error) {
      expect(error).toMatchObject({ kind: "not_found" });
    }
  });

  it("refuses a missing credential by name, never by value", async () => {
    const admin = recordingProxy();
    const proxy = createRunCredentialProxy({
      provider: providerWith(admin),
      credentials: credentialStore(),
      tokenSecret: proxySecret,
    });

    await expect(proxy.open(openRequest)).rejects.toBeInstanceOf(RunProxyCredentialError);

    try {
      await proxy.open(openRequest);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      expect(detail).toContain(credentialName);
      expect(detail).not.toContain(credentialValue);
    }

    expect(admin.grants).toHaveLength(0);
  });

  it("caps the capability's lifetime to the command budget and the ceiling", async () => {
    let now = 1_800_000_000;
    const admin = recordingProxy();
    const credentials = credentialStore([[credentialName, credentialValue]]);
    const proxy = createRunCredentialProxy({
      provider: providerWith(admin),
      credentials,
      tokenSecret: proxySecret,
      nowSeconds: () => now,
    });
    const handle = await proxy.open(openRequest);
    const codec = createProxyCapabilityCodec(proxySecret, { nowSeconds: () => now });

    // A command's budget is what the token covers: 700s of budget buys a 730s
    // token, not the 900s ceiling.
    const long = handle.environmentFor(700_000)[RUN_PROXY_TOKEN_ENV] ?? "";
    now += 729;
    expect(codec.verify(long, { runId: "run-1" }).valid).toBe(true);
    now += 2;
    expect(codec.verify(long, { runId: "run-1" })).toEqual({ valid: false, reason: "expired" });

    // A short command's token is short too: 1s of budget buys 31s, not the
    // 300s default, so a token read out of a finished command goes stale fast.
    now = 1_800_000_000;
    const short = handle.environmentFor(1_000)[RUN_PROXY_TOKEN_ENV] ?? "";
    now += 30;
    expect(codec.verify(short, { runId: "run-1" }).valid).toBe(true);
    now += 2;
    expect(codec.verify(short, { runId: "run-1" })).toEqual({ valid: false, reason: "expired" });
  });

  it("binds the capability to the run and the computer, so another run's token is refused", async () => {
    const admin = recordingProxy();
    const { proxy } = runProxy(admin);
    const handle = await proxy.open(openRequest);
    const token = handle.environmentFor(30_000)[RUN_PROXY_TOKEN_ENV] ?? "";
    const codec = createProxyCapabilityCodec(proxySecret);

    expect(codec.verify(token, { runId: "run-other" })).toEqual({
      valid: false,
      reason: "binding",
    });
    expect(codec.verify(token, { computerId: otherComputer.computerId })).toEqual({
      valid: false,
      reason: "binding",
    });
    expect(codec.verify(token, { botId: otherComputer.botId })).toEqual({
      valid: false,
      reason: "binding",
    });
  });

  it("rejects an expiry that is not a positive whole second", async () => {
    const admin = recordingProxy();
    const { proxy } = runProxy(admin);

    await expect(proxy.open({ ...openRequest, expiresAtSeconds: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(proxy.open({ ...openRequest, expiresAtSeconds: 1.5 })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(admin.grants).toHaveLength(0);
  });

  it("revokes through the provider, addressed to the run's own computer", async () => {
    const admin = recordingProxy();
    const { proxy } = runProxy(admin);
    const handle = await proxy.open(openRequest);

    await handle.revoke();

    expect(admin.revoked).toEqual([{ computer, runId: "run-1" }]);
  });
});

describe("a bot secret asked for mid-life (slice 9.6)", () => {
  const secretName = "example_api";
  const secretValue = "bot-secret-marker-value";
  const secretOrigin = "https://api.example.test";

  function botSecrets(entries: Iterable<readonly [string, string]> = []): BotSecretResolver {
    const stored = new Map(entries);

    return {
      resolve: (botId, name) => {
        if (botId !== computer.botId) {
          return Promise.resolve(undefined);
        }

        const value = stored.get(name);

        return Promise.resolve(
          value === undefined
            ? undefined
            : {
                destination: {
                  name,
                  origin: secretOrigin,
                  auth: { type: "bearer" as const },
                },
                value,
              },
        );
      },
    };
  }

  function proxyWith(admin: CredentialProxyAdmin, secrets: BotSecretResolver | undefined) {
    return createRunCredentialProxy({
      provider: providerWith(admin),
      credentials: credentialStore([[credentialName, credentialValue]]),
      ...(secrets === undefined ? {} : { botSecrets: secrets }),
      tokenSecret: proxySecret,
    });
  }

  it("resolves the stored value into one more upstream and republishes the whole grant", async () => {
    const admin = recordingProxy();
    const handle = await proxyWith(admin, botSecrets([[secretName, secretValue]])).open(
      openRequest,
    );

    await expect(handle.grantSecret(secretName)).resolves.toEqual({ status: "granted" });

    expect(admin.grants).toHaveLength(2);
    expect(admin.grants[1]?.upstreams).toEqual([
      {
        name: "model",
        origin: "https://api.model.example",
        headers: { authorization: `Bearer ${credentialValue}` },
      },
      {
        name: secretName,
        origin: secretOrigin,
        headers: { authorization: `Bearer ${secretValue}` },
      },
    ]);

    const environment = handle.environmentFor(30_000);
    expect(JSON.stringify(environment)).not.toContain(secretValue);
  });

  it("re-grants the same secret as a refresh rather than a name collision", async () => {
    const admin = recordingProxy();
    const handle = await proxyWith(admin, botSecrets([[secretName, secretValue]])).open(
      openRequest,
    );

    await handle.grantSecret(secretName);
    await expect(handle.grantSecret(secretName)).resolves.toEqual({ status: "granted" });

    expect(admin.grants).toHaveLength(3);
    expect(admin.grants[2]?.upstreams.filter(({ name }) => name === secretName)).toHaveLength(1);
  });

  it("answers missing without publishing anything", async () => {
    const admin = recordingProxy();
    const handle = await proxyWith(admin, botSecrets()).open(openRequest);

    await expect(handle.grantSecret(secretName)).resolves.toEqual({ status: "missing" });
    expect(admin.grants).toHaveLength(1);
  });

  it("answers name_taken for an upstream the opening plan already carries", async () => {
    const admin = recordingProxy();
    const handle = await proxyWith(admin, botSecrets([[secretName, secretValue]])).open({
      ...openRequest,
      upstreams: [
        { name: "model", origin: "https://api.model.example", credentialName },
        { name: secretName, origin: secretOrigin },
      ],
    });

    await expect(handle.grantSecret(secretName)).resolves.toEqual({ status: "name_taken" });
    expect(admin.grants).toHaveLength(1);
  });

  it("answers unavailable when the run has no secret resolver", async () => {
    const admin = recordingProxy();
    const handle = await proxyWith(admin, undefined).open(openRequest);

    await expect(handle.grantSecret(secretName)).resolves.toEqual({ status: "unavailable" });
    expect(admin.grants).toHaveLength(1);
  });

  it("takes one upstream back and republishes, so the next request cannot name it", async () => {
    const admin = recordingProxy();
    const handle = await proxyWith(admin, botSecrets([[secretName, secretValue]])).open(
      openRequest,
    );

    await handle.grantSecret(secretName);
    await handle.revokeSecret(secretName);

    expect(admin.grants).toHaveLength(3);
    expect(admin.grants[2]?.upstreams.map(({ name }) => name)).toEqual(["model"]);

    // Revoking a name the handle does not own publishes nothing.
    await handle.revokeSecret("never_granted");
    expect(admin.grants).toHaveLength(3);
  });

  it("refuses a late grant after the run's revoke rather than resurrecting the grant", async () => {
    const admin = recordingProxy();
    const handle = await proxyWith(admin, botSecrets([[secretName, secretValue]])).open(
      openRequest,
    );

    await handle.revoke();
    await expect(handle.grantSecret(secretName)).resolves.toEqual({ status: "unavailable" });
    expect(admin.grants).toHaveLength(1);
    expect(admin.revoked).toEqual([{ computer, runId: "run-1" }]);
  });
});
