import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The built artifact, served the way a deployment serves it. These tests run
 * only after `pnpm build`, against `dist/`, and prove the two acceptance
 * criteria that are about the artifact rather than the code: the build is
 * static — a file server is enough and no SSR process is required — and the
 * same `dist/client` directory is self-contained, which is what the Electron
 * wrapper packages.
 */

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const clientDirectory = path.join(packageRoot, "dist", "client");
const shellPath = path.join(clientDirectory, "_shell.html");

function startHost(): { child: ChildProcess; port: Promise<number> } {
  const child = spawn(process.execPath, ["dist/host/main.js"], {
    cwd: packageRoot,
    env: { ...process.env, PORT: "0", LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const port = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the host did not report a port")), 10_000);
    const lines = createInterface({ input: child.stdout });

    lines.on("line", (line) => {
      let record: { msg?: string; port?: number };

      try {
        record = JSON.parse(line) as { msg?: string; port?: number };
      } catch {
        return;
      }

      if (record.msg === "web listening" && typeof record.port === "number") {
        clearTimeout(timer);
        resolve(record.port);
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the host exited before listening (code ${code})`));
    });
  });

  return { child, port };
}

describe("the static SPA build", () => {
  let child: ChildProcess;
  let baseUrl = "";

  beforeAll(async () => {
    const host = startHost();
    child = host.child;
    baseUrl = `http://127.0.0.1:${await host.port}`;
  });

  afterAll(async () => {
    const stopped = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    child.kill("SIGTERM");
    await stopped;
  });

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

  it("serves the shell at the root and rewrites unknown routes to it", async () => {
    for (const route of ["/", "/sign-in", "/settings/notifications"]) {
      const response = await fetch(`${baseUrl}${route}`);

      expect(response.status, route).toBe(200);
      expect(response.headers.get("content-type"), route).toContain("text/html");
      expect(await response.text(), route).toContain("PorkBot");
    }
  });

  it("keeps a missing asset a 404", async () => {
    const response = await fetch(`${baseUrl}/assets/does-not-exist.js`);

    expect(response.status).toBe(404);
  });

  it("answers the health probe without a server-side renderer", async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "@porkbot/web" });
  });
});
