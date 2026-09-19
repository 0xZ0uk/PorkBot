import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProxyCapabilityCodec } from "@porkbot/effect";
import type { SafeFetch, SafeFetchInit } from "@porkbot/effect";
import type { ComputerProxyGrant } from "@porkbot/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialProxyServer,
  parseProxyGrantFile,
  proxyGrantFileName,
  proxyTokenHeader,
  serializeProxyGrant,
} from "./credential-proxy.ts";
import type { CredentialProxyServer } from "./credential-proxy.ts";

/**
 * The credential proxy's contract (slice 7.8).
 *
 * These are the acceptance checks the issue asks for, run against a real HTTP
 * server on loopback: a capability is verified before a grant is read, the
 * allowlist is per run, the credential crosses only in the injected headers,
 * and every bound — body, response, grant, time — is enforced. The upstream
 * leg is a recorded `SafeFetch` so the tests name exactly what the proxy put
 * on the wire without needing TLS.
 */

const SECRET = "test-proxy-secret";
const RUN = "run-abc";
const COMPUTER = { computerId: "computer-1", botId: "bot-1" };
const OTHER_COMPUTER = { computerId: "computer-2", botId: "bot-2" };

interface UpstreamCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

interface RecordingUpstream {
  readonly calls: UpstreamCall[];
  queue(response: Response): void;
  readonly fetch: SafeFetch;
}

function recordingUpstream(): RecordingUpstream {
  const calls: UpstreamCall[] = [];
  const queued: Response[] = [];

  return {
    calls,
    queue(response: Response): void {
      queued.push(response);
    },
    fetch: async (url: string | URL, init?: SafeFetchInit): Promise<Response> => {
      const headers: Record<string, string> = {};

      if (init?.headers !== undefined) {
        for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
          headers[key] = value;
        }
      }

      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        headers,
        body:
          typeof init?.body === "string"
            ? init.body
            : init?.body instanceof Uint8Array
              ? Buffer.from(init.body).toString("utf8")
              : undefined,
      });

      const queued_ = queued.shift();

      return (
        queued_ ??
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    },
  };
}

function grant(overrides: Partial<ComputerProxyGrant> = {}): ComputerProxyGrant {
  return {
    runId: RUN,
    expiresAtSeconds: Math.floor(Date.now() / 1_000) + 3_600,
    upstreams: [
      {
        name: "model",
        origin: "https://api.model.example",
        headers: { authorization: "Bearer sk-secret-marker" },
      },
      { name: "github", origin: "https://api.github.example" },
    ],
    ...overrides,
  };
}

const servers: CredentialProxyServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startProxy(
  overrides: Partial<Parameters<typeof createCredentialProxyServer>[0]> = {},
): Promise<{ server: CredentialProxyServer; grantDir: string; upstream: RecordingUpstream }> {
  const grantDir = await mkdtemp(path.join(tmpdir(), "porkbot-proxy-grants-"));
  dirs.push(grantDir);
  const upstream = recordingUpstream();
  const server = await createCredentialProxyServer({
    tokenSecret: SECRET,
    computer: COMPUTER,
    grantDir,
    host: "127.0.0.1",
    port: 0,
    fetch: upstream.fetch,
    ...overrides,
  });
  servers.push(server);

  return { server, grantDir, upstream };
}

async function writeGrant(grantDir: string, value: ComputerProxyGrant | string): Promise<void> {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : serializeProxyGrant(value);
  await writeFile(path.join(grantDir, proxyGrantFileName(RUN)), bytes);
}

function token(
  binding: { runId?: string; computerId?: string; botId?: string } = {},
  ttlSeconds?: number,
): string {
  const codec = createProxyCapabilityCodec(SECRET);

  return codec.mint(
    {
      runId: binding.runId ?? RUN,
      computerId: binding.computerId ?? COMPUTER.computerId,
      botId: binding.botId ?? COMPUTER.botId,
    },
    ttlSeconds,
  );
}

async function request(
  server: CredentialProxyServer,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(`${server.url}${path}`, init);
}

describe("the credential proxy", () => {
  it("forwards an allowed request and injects the grant's credential headers", async () => {
    const { server, grantDir, upstream } = await startProxy();
    await writeGrant(grantDir, grant());

    const response = await request(server, "/u/model/v1/chat/completions", {
      method: "POST",
      headers: {
        [proxyTokenHeader]: token(),
        "content-type": "application/json",
        authorization: "Bearer smuggled",
        cookie: "session=stolen",
      },
      body: JSON.stringify({ prompt: "hi" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toBe("https://api.model.example/v1/chat/completions");
    expect(upstream.calls[0]?.method).toBe("POST");
    expect(upstream.calls[0]?.headers["authorization"]).toBe("Bearer sk-secret-marker");
    expect(upstream.calls[0]?.headers["content-type"]).toBe("application/json");
    expect(upstream.calls[0]?.headers["cookie"]).toBeUndefined();
    expect(upstream.calls[0]?.headers[proxyTokenHeader]).toBeUndefined();
    expect(upstream.calls[0]?.body).toBe(JSON.stringify({ prompt: "hi" }));
  });

  it("refuses a missing, forged or foreign capability before any grant is read", async () => {
    const { server, grantDir, upstream } = await startProxy();
    await writeGrant(grantDir, grant());

    expect((await request(server, "/u/model/x")).status).toBe(401);
    expect(
      (
        await request(server, "/u/model/x", {
          headers: { [proxyTokenHeader]: "garbage" },
        })
      ).status,
    ).toBe(401);

    const foreignKey = createProxyCapabilityCodec("another-key").mint({
      runId: RUN,
      computerId: COMPUTER.computerId,
      botId: COMPUTER.botId,
    });
    expect(
      (await request(server, "/u/model/x", { headers: { [proxyTokenHeader]: foreignKey } })).status,
    ).toBe(401);

    // A valid token bound to another computer is a binding refusal — it
    // proves the signature but not the scope.
    const other = token({ computerId: OTHER_COMPUTER.computerId, botId: OTHER_COMPUTER.botId });
    expect(
      (await request(server, "/u/model/x", { headers: { [proxyTokenHeader]: other } })).status,
    ).toBe(403);

    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses a token minted for a different run when that run has no grant", async () => {
    const { server, grantDir, upstream } = await startProxy();
    await writeGrant(grantDir, grant());

    const otherRun = token({ runId: "run-other" });
    const response = await request(server, "/u/model/x", {
      headers: { [proxyTokenHeader]: otherRun },
    });

    // The token is valid and bound to this computer, but the run it names
    // has no grant here — one run cannot use another's credentials.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_grant" });
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses an expired capability and an expired grant", async () => {
    let now = 1_800_000_000;
    const { server, grantDir, upstream } = await startProxy({ nowSeconds: () => now });
    await writeGrant(grantDir, grant({ expiresAtSeconds: now + 100 }));

    const codec = createProxyCapabilityCodec(SECRET, { nowSeconds: () => now });
    const good = codec.mint(
      { runId: RUN, computerId: COMPUTER.computerId, botId: COMPUTER.botId },
      60,
    );

    expect(
      (await request(server, "/u/model/x", { headers: { [proxyTokenHeader]: good } })).status,
    ).toBe(200);

    now += 61;
    expect(
      (await request(server, "/u/model/x", { headers: { [proxyTokenHeader]: good } })).status,
    ).toBe(401);

    now += 100;
    const fresh = codec.mint(
      { runId: RUN, computerId: COMPUTER.computerId, botId: COMPUTER.botId },
      300,
    );
    const response = await request(server, "/u/model/x", {
      headers: { [proxyTokenHeader]: fresh },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_grant" });
    expect(upstream.calls).toHaveLength(1);
  });

  it("refuses a revoked grant the moment its file is gone", async () => {
    const { server, grantDir, upstream } = await startProxy();
    await writeGrant(grantDir, grant());

    expect(
      (await request(server, "/u/model/x", { headers: { [proxyTokenHeader]: token() } })).status,
    ).toBe(200);

    await rm(path.join(grantDir, proxyGrantFileName(RUN)));

    expect(
      (await request(server, "/u/model/x", { headers: { [proxyTokenHeader]: token() } })).status,
    ).toBe(403);
    expect(upstream.calls).toHaveLength(1);
  });

  it("enforces the per-run upstream allowlist and refuses non-HTTPS origins", async () => {
    const { server, grantDir, upstream } = await startProxy();
    await writeGrant(
      grantDir,
      grant({
        upstreams: [
          { name: "model", origin: "https://api.model.example" },
          { name: "plaintext", origin: "http://insecure.example" },
        ],
      }),
    );

    expect(
      (await request(server, "/u/model/x", { headers: { [proxyTokenHeader]: token() } })).status,
    ).toBe(200);

    const named = await request(server, "/u/unlisted/x", {
      headers: { [proxyTokenHeader]: token() },
    });
    expect(named.status).toBe(403);
    expect(await named.json()).toEqual({ error: "upstream_not_allowed" });

    // A decoded segment that could re-enter the URL's authority is refused
    // before the request is assembled, so the sandbox cannot make the proxy
    // dial a host the grant never named. (Literal `//` never reaches the
    // proxy — URL parsing collapses it — so the encoded forms are the ones
    // that matter.)
    for (const escape of ["/%2F%2Fevil.example/x", "/%5Cevil.example", "/%2F%5Cevil.example"]) {
      const escaped = await request(server, `/u/model${escape}`, {
        headers: { [proxyTokenHeader]: token() },
      });

      expect(escaped.status).toBe(400);
      expect(await escaped.json()).toEqual({ error: "bad_upstream_path" });
    }

    const insecure = await request(server, "/u/plaintext/x", {
      headers: { [proxyTokenHeader]: token() },
    });
    expect(insecure.status).toBe(403);
    expect(await insecure.json()).toEqual({ error: "upstream_not_allowed" });

    expect(upstream.calls).toHaveLength(1);
  });

  it("offers no route that enumerates or reads a grant", async () => {
    const { server, grantDir } = await startProxy();
    await writeGrant(grantDir, grant());

    for (const probe of ["/", "/grants", "/u", "/admin", `/u/${RUN}`]) {
      const response = await request(server, probe, {
        headers: { [proxyTokenHeader]: token() },
      });

      expect(response.status).toBeOneOf([403, 404, 405]);
    }

    expect((await request(server, "/healthz")).status).toBe(200);
  });

  it("caps the request body and the upstream response", async () => {
    const { server, grantDir, upstream } = await startProxy({
      maxRequestBytes: 64,
      maxResponseBytes: 64,
    });
    await writeGrant(grantDir, grant());

    const tooLarge = await request(server, "/u/model/x", {
      method: "POST",
      headers: { [proxyTokenHeader]: token(), "content-length": "100" },
      body: "x".repeat(100),
    });
    expect(tooLarge.status).toBe(413);

    upstream.queue(
      new Response("y".repeat(200), { status: 200, headers: { "content-length": "200" } }),
    );
    const oversized = await request(server, "/u/model/x", {
      headers: { [proxyTokenHeader]: token() },
    });
    expect(oversized.status).toBe(502);
    expect(await oversized.json()).toEqual({ error: "upstream_response_too_large" });
  });

  it("answers an upstream failure with a refusal that names no detail", async () => {
    const { server, grantDir, upstream } = await startProxy();
    await writeGrant(grantDir, grant());

    upstream.queue(new Response(null, { status: 500 }) as Response);
    // A refused socket, not an HTTP error: the fetch itself throws.
    const failing: SafeFetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    servers.splice(servers.indexOf(server), 1);
    await server.close();

    const replacement = await createCredentialProxyServer({
      tokenSecret: SECRET,
      computer: COMPUTER,
      grantDir,
      host: "127.0.0.1",
      port: 0,
      fetch: failing,
    });
    servers.push(replacement);

    const response = await request(replacement, "/u/model/x", {
      headers: { [proxyTokenHeader]: token() },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_refused" });
  });

  it("refuses a malformed grant file closed", async () => {
    const { server, grantDir, upstream } = await startProxy();
    await writeGrant(grantDir, "{ not json");

    const response = await request(server, "/u/model/x", {
      headers: { [proxyTokenHeader]: token() },
    });

    expect(response.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
  });

  it("rejects grant file names that could escape the grant directory", () => {
    expect(() => proxyGrantFileName("../escape")).toThrow(RangeError);
    expect(() => proxyGrantFileName("a/b")).toThrow(RangeError);
    expect(() => proxyGrantFileName("")).toThrow(RangeError);
    expect(proxyGrantFileName("run-abc_1.2")).toBe("run-abc_1.2.json");
  });

  it("refuses a grant whose injected headers would rewrite the request's framing", () => {
    const value = grant();

    // A host, a content-length or a newline in a header is not a credential;
    // it is an attempt to control the connection the proxy owns, and the
    // grant fails closed rather than being forwarded.
    expect(
      parseProxyGrantFile(
        RUN,
        serializeProxyGrant({
          ...value,
          upstreams: [
            {
              name: "model",
              origin: "https://api.model.example",
              headers: { host: "elsewhere.example" },
            },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseProxyGrantFile(
        RUN,
        serializeProxyGrant({
          ...value,
          upstreams: [
            {
              name: "model",
              origin: "https://api.model.example",
              headers: { authorization: "Bearer ok\r\nhost: elsewhere.example" },
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("round-trips a grant through its file form", () => {
    const value = grant();

    expect(parseProxyGrantFile(RUN, serializeProxyGrant(value))).toEqual(value);
    expect(parseProxyGrantFile("run-other", serializeProxyGrant(value))).toBeUndefined();
    expect(parseProxyGrantFile(RUN, Buffer.from("[]", "utf8"))).toBeUndefined();
    expect(
      parseProxyGrantFile(
        RUN,
        serializeProxyGrant({ ...value, upstreams: [{ name: "x", origin: 1 } as never] }),
      ),
    ).toBeUndefined();
  });
});
