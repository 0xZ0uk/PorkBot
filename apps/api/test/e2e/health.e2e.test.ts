import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

function startApi(env: Readonly<Record<string, string>> = {}): {
  child: ChildProcess;
  port: Promise<number>;
} {
  const child = spawn(process.execPath, ["src/main.ts"], {
    // LOG_LEVEL is pinned so an ambient level above info cannot filter the
    // startup line this test waits for. DATABASE_URL is a placeholder: the
    // process constructs its pool without connecting, and this spec never
    // calls a data-backed procedure.
    env: {
      ...process.env,
      PORT: "0",
      LOG_LEVEL: "info",
      DATABASE_URL: "postgres://porkbot:e2e-placeholder@127.0.0.1:5432/porkbot",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const port = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("api did not report a port")), 10_000);
    const lines = createInterface({ input: child.stdout });

    lines.on("line", (line) => {
      let record: { msg?: string; port?: number };
      try {
        record = JSON.parse(line) as { msg?: string; port?: number };
      } catch {
        return;
      }

      if (record.msg === "api listening" && typeof record.port === "number") {
        clearTimeout(timer);
        resolve(record.port);
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`api exited before listening (code ${code})`));
    });
  });

  return { child, port };
}

describe("api process", () => {
  it("starts, serves /healthz over HTTP and stops on SIGTERM", async () => {
    const { child, port } = startApi();
    const stopped = new Promise<void>((resolve) => child.on("exit", () => resolve()));

    try {
      const response = await fetch(`http://127.0.0.1:${await port}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", service: "@porkbot/api" });
    } finally {
      child.kill("SIGTERM");
    }

    await stopped;
    expect(child.exitCode).toBe(0);
  }, 15_000);

  it("enforces the environment's limits on the real process", async () => {
    const { child, port } = startApi({ PORKBOT_LIMIT_PROBE_PER_MINUTE: "1" });

    try {
      const base = `http://127.0.0.1:${await port}`;
      const first = await fetch(`${base}/healthz`);

      expect(first.status).toBe(200);

      const second = await fetch(`${base}/healthz`);

      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("60");
      expect(await second.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 60 });
    } finally {
      child.kill("SIGTERM");
    }
  }, 15_000);

  it("refuses to boot on a limit that is not a positive integer", async () => {
    const { child, port } = startApi({ PORKBOT_LIMIT_MAX_BODY_BYTES: "nope" });

    await expect(port).rejects.toThrow(/api exited before listening/);
    expect(child.exitCode).toBe(1);
  }, 15_000);

  it("mounts the webhook ingress and refuses an unsigned delivery", async () => {
    const { child, port } = startApi();

    try {
      const response = await fetch(`http://127.0.0.1:${await port}/webhooks/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "opened" }),
      });

      // No source is registered, so the deployment fails closed before it
      // touches the database; the placeholder URL is never dialled.
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    } finally {
      child.kill("SIGTERM");
    }
  }, 15_000);
});
