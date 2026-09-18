import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

function startApi(): { child: ChildProcess; port: Promise<number> } {
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
});
