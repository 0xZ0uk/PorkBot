import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticServer, shellFileName, serviceName } from "./host.ts";

/**
 * The static host, against a fixture that mirrors the real artifact: a shell
 * (`_shell.html`, which is what the SPA build emits) and hashed assets, with no
 * `index.html` and no server routes. The rewrite it implements here is the same
 * one the single TLS origin implements in a deployment.
 */

let root = "";
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "porkbot-web-host-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, shellFileName), "<!doctype html><title>PorkBot shell</title>");
  await writeFile(path.join(root, "assets", "index-abc123.js"), "export {};\n");

  server = createStaticServer({ root });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  await rm(root, { recursive: true, force: true });
});

describe("the static host", () => {
  it("serves the shell at the root and for an unknown client route", async () => {
    for (const route of ["/", "/sign-in", "/settings/models"]) {
      const response = await fetch(`${baseUrl}${route}`);

      expect(response.status, route).toBe(200);
      expect(response.headers.get("content-type"), route).toBe("text/html; charset=utf-8");
      expect(await response.text(), route).toContain("PorkBot shell");
    }
  });

  it("serves an asset with its content type", async () => {
    const response = await fetch(`${baseUrl}/assets/index-abc123.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe("export {};\n");
  });

  it("answers the health probe with the service identity", async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: serviceName });
  });

  it("keeps a missing asset a 404 instead of answering the shell", async () => {
    const response = await fetch(`${baseUrl}/assets/missing.js`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("refuses a path that escapes the root", async () => {
    const response = await fetch(`${baseUrl}/..%2f..%2fetc%2fpasswd`);

    expect(response.status).toBe(404);
  });

  it("refuses a write", async () => {
    const response = await fetch(`${baseUrl}/`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
