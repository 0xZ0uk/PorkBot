import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostGatewayAddress, startCaddyProxy } from "@porkbot/testkit";
import type { RunningCaddyProxy } from "@porkbot/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The built artifact, served the way a deployment serves it (slice 14.7): by
 * the shipped `deploy/Caddyfile` in the pinned Caddy image, with `dist/client`
 * mounted where the proxy image bakes it. These tests run only after
 * `pnpm build` and prove what is about the artifact and the proxy together:
 * the build is static — a file server is enough and no SSR process is required
 * — the same `dist/client` directory is self-contained, which is what the
 * Electron wrapper packages, and the deep-link fallback and the asset cache
 * headers are intact after the move from the static host to the proxy.
 */

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const clientDirectory = path.join(packageRoot, "dist", "client");
const shellPath = path.join(clientDirectory, "_shell.html");

/** Answers the proxy's healthcheck route so the container reports healthy. */
const apiStub: Server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "ok", service: "@porkbot/api" }));
});

let proxy: RunningCaddyProxy | undefined;

function baseUrl(): string {
  if (proxy === undefined) {
    throw new Error("the proxy was not started; the beforeAll hook failed first");
  }

  return proxy.siteUrl;
}

beforeAll(async () => {
  const gateway = await hostGatewayAddress();

  await new Promise<void>((resolve) => {
    apiStub.listen(0, gateway, resolve);
  });

  const address = apiStub.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  proxy = await startCaddyProxy({
    siteAddress: "http://localhost:8080",
    apiUpstream: `http://host.docker.internal:${String(address.port)}`,
    webRoot: clientDirectory,
  });
}, 120_000);

afterAll(async () => {
  await proxy?.stop();

  await new Promise<void>((resolve, reject) => {
    apiStub.closeAllConnections();
    apiStub.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("the static SPA build", () => {
  it("prerenders one shell whose asset references all exist in the artifact", async () => {
    const shell = await readFile(shellPath, "utf8");
    const references = [...shell.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );

    expect(references.length).toBeGreaterThan(0);

    for (const reference of references) {
      await expect(access(path.join(clientDirectory, reference.slice(1)))).resolves.toBeUndefined();
    }
  });

  it("renders the bootstrapping state before the bundle runs", async () => {
    const shell = await readFile(shellPath, "utf8");

    expect(shell).toContain('role="status"');
    expect(shell).toContain("Checking your session");
  });
});

describe("the SPA served through the shipped proxy", () => {
  it("loads the shell at the root and deep-links a client route to it", async () => {
    for (const route of ["/", "/sign-in", "/settings/notifications"]) {
      const response = await fetch(`${baseUrl()}${route}`);

      expect(response.status, route).toBe(200);
      expect(response.headers.get("content-type"), route).toContain("text/html");
      expect(await response.text(), route).toContain("PorkBot");
    }
  });

  it("keeps a missing asset a 404 instead of the shell", async () => {
    const response = await fetch(`${baseUrl()}/assets/does-not-exist.js`);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<!doctype html>");
  });

  it("caches a hashed asset forever and the document never", async () => {
    const shell = await readFile(shellPath, "utf8");
    const reference = /(?:src|href)="(\/assets\/[^"]+)"/.exec(shell)?.[1];

    expect(reference).toBeDefined();

    const asset = await fetch(`${baseUrl()}${reference ?? ""}`);

    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const document = await fetch(`${baseUrl()}/sign-in`);

    expect(document.status).toBe(200);
    expect(document.headers.get("cache-control")).toBe("no-cache");
  });
});
