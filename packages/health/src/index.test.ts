import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHealthListener,
  createHealthServer,
  createHealthStreamProbe,
  healthPath,
  healthStreamFrameCount,
  healthStreamFrameIntervalMs,
  healthStreamPath,
  livenessPath,
  readinessPath,
} from "./index.ts";

const service = "@porkbot/test-health";
const server: Server = createHealthServer({ service });
let baseUrl = "";

beforeAll(async () => {
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
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

describe("the health listener", () => {
  it("claims the probe and leaves every other request alone", () => {
    const listener = createHealthListener({ service });
    const writes: string[] = [];
    const response = {
      writeHead(status: number): void {
        writes.push(`status:${status}`);
      },
      end(body?: string): void {
        writes.push(`end:${body ?? ""}`);
      },
    } as unknown as ServerResponse;

    expect(listener({ method: "GET", url: "/" } as IncomingMessage, response)).toBe(false);
    expect(listener({ method: "POST", url: healthPath } as IncomingMessage, response)).toBe(false);
    expect(writes).toEqual([]);

    expect(listener({ method: "GET", url: healthPath } as IncomingMessage, response)).toBe(true);
    expect(writes).toEqual(["status:200", `end:${JSON.stringify({ status: "ok", service })}`]);

    expect(listener({ method: "GET", url: livenessPath } as IncomingMessage, response)).toBe(true);
  });
});

describe("the health server", () => {
  it("answers the probe with the service identity", async () => {
    const response = await fetch(`${baseUrl}${healthPath}`);
    const body = (await response.json()) as { status: string; service: string };

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", service });
  });

  it("keeps liveness up while readiness reports a dependency failure", async () => {
    let dependencyUp = true;
    const serverWithDependency = createHealthServer({
      service,
      readiness: () => dependencyUp,
    });

    await new Promise<void>((resolve) => {
      serverWithDependency.listen(0, "127.0.0.1", resolve);
    });

    const address = serverWithDependency.address();

    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }

    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const live = await fetch(`${origin}${livenessPath}`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok", service });

      dependencyUp = false;
      const ready = await fetch(`${origin}${readinessPath}`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "not_ready", service });

      const stillLive = await fetch(`${origin}${livenessPath}`);
      expect(stillLive.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        serverWithDependency.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("does not expose dependency details in a failed readiness response", async () => {
    const serverWithFailure = createHealthServer({
      service,
      readiness: () => {
        throw new Error("postgres://user:password@database.internal:5432/app");
      },
    });

    await new Promise<void>((resolve) => {
      serverWithFailure.listen(0, "127.0.0.1", resolve);
    });

    const address = serverWithFailure.address();

    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${readinessPath}`);
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(body).toBe(JSON.stringify({ status: "not_ready", service }));
      expect(body).not.toContain("password");
      expect(body).not.toContain("database.internal");
    } finally {
      await new Promise<void>((resolve, reject) => {
        serverWithFailure.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects methods other than GET", async () => {
    const response = await fetch(`${baseUrl}${healthPath}`, { method: "POST" });

    expect(response.status).toBe(404);
  });

  it("answers unknown routes with 404", async () => {
    const response = await fetch(`${baseUrl}/unknown`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

/** The `id: n` and `data:` lines of every frame in a probe body, in order. */
function framesOf(body: string): { id: string; data: string }[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      const lines = frame.split("\n");
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";

      return { id, data };
    });
}

describe("the health stream probe", () => {
  const probe = createHealthStreamProbe({ intervalMs: 40 });

  it("numbers its frames and says what each one is", async () => {
    const response = probe(new Request(`http://127.0.0.1${healthStreamPath}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const frames = framesOf(await response.text());

    expect(frames).toHaveLength(healthStreamFrameCount);
    expect(frames.map((frame) => frame.id)).toEqual(["1", "2", "3"]);
    expect(frames.map((frame) => JSON.parse(frame.data))).toEqual([
      { probe: 1 },
      { probe: 2 },
      { probe: 3 },
    ]);
  });

  it("opens a gap between frames so a buffered response is visible", async () => {
    const response = probe(new Request(`http://127.0.0.1${healthStreamPath}`));
    const reader = response.body?.getReader();

    if (reader === undefined) {
      throw new Error("the probe answered without a body");
    }

    const arrivals: number[] = [];
    const decoder = new TextDecoder();
    let text = "";

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      text += decoder.decode(value, { stream: true });

      // Count the frames in everything read so far, so a frame split across
      // two chunks is still one arrival.
      const seen = [...text.matchAll(/id: \d+/g)].length;

      while (arrivals.length < seen) {
        arrivals.push(Date.now());
      }
    }

    expect(arrivals).toHaveLength(healthStreamFrameCount);
    // The shipped gap is what the runbook tells an operator to look for; this
    // probe uses a shorter one so the unit suite stays quick, and the real
    // interval is asserted as the default it is.
    expect(healthStreamFrameIntervalMs).toBe(250);
    expect((arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0)).toBeGreaterThanOrEqual(40);
  });

  it("resumes after the frame Last-Event-ID names", async () => {
    const response = probe(
      new Request(`http://127.0.0.1${healthStreamPath}`, {
        headers: { "last-event-id": "2" },
      }),
    );
    const frames = framesOf(await response.text());

    expect(frames.map((frame) => frame.id)).toEqual(["3"]);
  });

  it("answers a cursor past the end with no frames", async () => {
    const response = probe(
      new Request(`http://127.0.0.1${healthStreamPath}`, {
        headers: { "last-event-id": String(healthStreamFrameCount) },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("refuses a malformed cursor instead of replaying the stream", async () => {
    const response = probe(
      new Request(`http://127.0.0.1${healthStreamPath}`, {
        headers: { "last-event-id": "not-a-number" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "bad_request",
      message: "Last-Event-ID must be a frame number",
    });
  });
});
