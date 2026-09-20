import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAppServer,
  isApiPath,
  rewriteSetCookie,
  serverAddressPath,
  setupPagePath,
} from "./proxy.ts";
import type { AppServer } from "./proxy.ts";

/**
 * The loopback origin, over real HTTP: a fixture web build served the way the
 * deployment serves it, a fixture upstream standing in for the operator's
 * server, and the proxy between them. The tests assert the four things the
 * renderer depends on — the SPA contract, the RPC and auth mounts, the cookie
 * it gets back and the frames that must arrive one at a time — plus the setup
 * door that writes the one setting.
 */

interface SeenRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

const seen: SeenRequest[] = [];

let clientRoot = "";
let upstream: Server;
let upstreamOrigin = "";
let app: AppServer;
let baseUrl = "";
let configuredOrigin: string | null = null;
const saved: string[] = [];

function origin(): string | null {
  return configuredOrigin;
}

beforeAll(async () => {
  clientRoot = await mkdtemp(path.join(tmpdir(), "porkbot-desktop-client-"));
  await mkdir(path.join(clientRoot, "assets"));
  await writeFile(
    path.join(clientRoot, "_shell.html"),
    '<!doctype html><title>PorkBot shell</title><script>console.log("boot")</script>',
  );
  await writeFile(path.join(clientRoot, "assets", "index-abc.js"), "export {};\n");

  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      const url = new URL(request.url ?? "/", "http://upstream");

      if (url.pathname === "/rpc" && url.searchParams.get("stream") === "1") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write('id: 1\ndata: {"first":true}\n\n');
        setTimeout(() => {
          response.write('id: 2\ndata: {"second":true}\n\n');
          response.end();
        }, 200);
        return;
      }

      if (url.pathname === "/rpc" || url.pathname.startsWith("/rpc/")) {
        response.writeHead(200, {
          "content-type": "application/json",
          "x-upstream": "rpc",
          "set-cookie":
            "porkbot.session=abc; Path=/; HttpOnly; Secure; SameSite=None; Domain=upstream.example",
        });
        response.end(JSON.stringify({ ok: true, method: request.method }));
        return;
      }

      if (url.pathname === "/api/auth/sign-in/email") {
        response.writeHead(200, {
          "set-cookie": ["first=1; HttpOnly; Secure", "second=2; Max-Age=60"],
        });
        response.end(JSON.stringify({ accepted: true }));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    })();
  });

  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });

  const upstreamAddress = upstream.address();

  if (upstreamAddress === null || typeof upstreamAddress === "string") {
    throw new Error("expected an upstream TCP address");
  }

  upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;

  app = createAppServer({
    clientRoot,
    serverOrigin: origin,
    saveServerOrigin: async (value) => {
      saved.push(value);
      configuredOrigin = value;
    },
  });

  const port = await app.listen(0);

  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) => {
    upstream.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(clientRoot, { recursive: true, force: true });
});

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

describe("the desktop host", () => {
  it("serves the SPA contract from the packaged build", async () => {
    for (const route of ["/", "/sign-in", "/threads/one"]) {
      const response = await fetch(`${baseUrl}${route}`);

      expect(response.status, route).toBe(200);
      expect(await response.text(), route).toContain("PorkBot shell");
    }

    const asset = await fetch(`${baseUrl}/assets/index-abc.js`);

    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

    const missing = await fetch(`${baseUrl}/assets/missing.js`);

    expect(missing.status).toBe(404);
  });

  it("stamps a fresh nonce onto every served document and names it in the policy", async () => {
    const first = await fetch(`${baseUrl}/`);
    const second = await fetch(`${baseUrl}/`);
    const firstPolicy = first.headers.get("content-security-policy") ?? "";
    const secondPolicy = second.headers.get("content-security-policy") ?? "";
    const firstNonce = /'nonce-([^']+)'/.exec(firstPolicy)?.[1];
    const secondNonce = /'nonce-([^']+)'/.exec(secondPolicy)?.[1];

    expect(firstNonce).toBeDefined();
    expect(secondNonce).toBeDefined();
    expect(firstNonce).not.toBe(secondNonce);
    expect(firstPolicy).toContain(`script-src 'self' 'nonce-${firstNonce ?? ""}'`);
    expect(firstPolicy).not.toContain("unsafe-inline");

    const body = await first.text();

    // The inline script the fixture shell ships is stamped with the nonce the
    // header names, so the browser runs it and nothing else.
    expect(body).toContain(`<script nonce="${firstNonce ?? ""}">`);
  });

  it("refuses an API call before a server is configured", async () => {
    const response = await fetch(`${baseUrl}/rpc`, { method: "POST" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "server_not_configured" });
  });

  it("writes the addressed server through the setup door", async () => {
    const page = await fetch(`${baseUrl}${setupPagePath}`);
    const pagePolicy = page.headers.get("content-security-policy") ?? "";
    const pageNonce = /'nonce-([^']+)'/.exec(pagePolicy)?.[1];

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connect PorkBot");
    expect(pageNonce).toBeDefined();
    expect(pagePolicy).toContain(`script-src 'self' 'nonce-${pageNonce ?? ""}'`);

    const retried = await fetch(`${baseUrl}${serverAddressPath}`);

    expect(retried.status).toBe(405);

    const refused = await fetch(`${baseUrl}${serverAddressPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "http://porkbot.example.com" }),
    });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "insecure" });
    expect(saved).toEqual([]);

    const accepted = await fetch(`${baseUrl}${serverAddressPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "http://127.0.0.1" }),
    });

    expect(accepted.status).toBe(204);
    expect(saved).toEqual(["http://127.0.0.1"]);
    expect(origin()).toBe("http://127.0.0.1");

    // Put the fixture back so the remaining tests dial the upstream.
    configuredOrigin = null;
    await fetch(`${baseUrl}${serverAddressPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: upstreamOrigin }),
    });

    expect(origin()).toBe(upstreamOrigin);
  });

  it("proxies the RPC mount with the caller's body, cookie and origin", async () => {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "porkbot.session=abc",
        "last-event-id": "41",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream")).toBe("rpc");
    expect(await response.json()).toEqual({ ok: true, method: "POST" });

    const forwarded = seen.at(-1);

    expect(forwarded?.url).toBe("/rpc");
    expect(forwarded?.body).toBe(JSON.stringify({ hello: "world" }));
    expect(forwarded?.headers["cookie"]).toBe("porkbot.session=abc");
    expect(forwarded?.headers["last-event-id"]).toBe("41");
    expect(forwarded?.headers["origin"]).toBe(upstreamOrigin);
    expect(forwarded?.headers["host"]).toBe(new URL(upstreamOrigin).host);

    // oRPC addresses procedures below the mount by path; the proxy must not
    // mistake `/rpc/account/me` for a client route.
    const procedure = await fetch(`${baseUrl}/rpc/account/me`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(procedure.status).toBe(200);
    expect(seen.at(-1)?.url).toBe("/rpc/account/me");
  });

  it("normalizes the session cookie onto the loopback origin", async () => {
    const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "operator@example.com", password: "placeholder" }),
    });

    expect(response.status).toBe(200);

    const cookies = response.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe("first=1; Path=/; SameSite=Lax; HttpOnly");
    expect(cookies[1]).toBe("second=2; Path=/; SameSite=Lax; Max-Age=60");
  });

  it("streams the event frames through instead of buffering them", async () => {
    const response = await fetch(`${baseUrl}/rpc?stream=1`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body?.getReader();

    expect(reader).toBeDefined();
    if (reader === undefined) {
      return;
    }

    const first = await withTimeout(reader.read(), 1000, "the first frame was buffered");

    expect(new TextDecoder().decode(first.value)).toContain("first");

    const second = await withTimeout(reader.read(), 2000, "the second frame never arrived");

    expect(new TextDecoder().decode(second.value)).toContain("second");

    await reader.cancel();
  });
});

describe("the API path register", () => {
  it("knows the two mounts the web client dials and nothing else", () => {
    expect(isApiPath("/rpc")).toBe(true);
    expect(isApiPath("/rpc/account/me")).toBe(true);
    expect(isApiPath("/rpc/threads/events")).toBe(true);
    expect(isApiPath("/api/auth/sign-in/email")).toBe(true);
    expect(isApiPath("/api")).toBe(false);
    expect(isApiPath("/apifoo")).toBe(false);
    expect(isApiPath("/rpcfoo")).toBe(false);
    expect(isApiPath("/sign-in")).toBe(false);
  });
});

describe("set-cookie rewriting", () => {
  it("keeps the value, expiry and HttpOnly and drops what only fits the server origin", () => {
    expect(
      rewriteSetCookie("session=abc; Path=/api; Domain=porkbot.example.com; Secure; HttpOnly"),
    ).toBe("session=abc; Path=/; SameSite=Lax; HttpOnly");
    expect(rewriteSetCookie("session=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=60")).toBe(
      "session=abc; Path=/; SameSite=Lax; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=60",
    );
  });
});
