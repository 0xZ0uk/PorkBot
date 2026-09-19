import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerProviderError } from "./computer-errors.ts";
import {
  createSupervisorComputerProvider,
  supervisorProtocolHeader,
  supervisorProtocolVersion,
} from "./supervisor-computer.ts";

/**
 * The supervisor client against a scripted wire. The round trip against the
 * real supervisor server is proven in `apps/supervisor`, which owns that half;
 * this suite is about the classification rules the client alone is responsible
 * for: a provider failure survives as the same kind, a malformed answer is a
 * defect rather than a lifecycle decision, and the service token never reaches
 * an error message.
 */

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
}

interface StubResponse {
  readonly status: number;
  readonly body: unknown;
}

async function startStub(
  respond: (request: RecordedRequest) => StubResponse | undefined,
): Promise<{ readonly origin: string; readonly requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = [];

    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const request: RecordedRequest = {
        method: incoming.method ?? "",
        path: incoming.url ?? "",
        headers: incoming.headers,
        body: raw === "" ? undefined : JSON.parse(raw),
      };
      requests.push(request);

      const response = respond(request) ?? {
        status: 500,
        body: { error: { kind: "gone", message: "the stub was not scripted" } },
      };

      outgoing.writeHead(response.status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(response.body));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  openServers.push(server);

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("the stub server did not bind a TCP port");
  }

  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

const computer = { computerId: "computer-1", botId: "bot-1" } as const;

function clientFor(origin: string, fetchImpl?: typeof globalThis.fetch) {
  return createSupervisorComputerProvider({
    baseUrl: origin,
    token: "supervisor-token",
    requestTimeoutMs: 5_000,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

describe("the supervisor computer client", () => {
  it("sends the service credential and the protocol version it speaks", async () => {
    const stub = await startStub(() => ({
      status: 200,
      body: { status: { computer, state: "running", instanceId: "container-1" } },
    }));

    await clientFor(stub.origin).ensure(computer);

    const [request] = stub.requests;

    expect(request?.headers["authorization"]).toBe("Bearer supervisor-token");
    expect(request?.headers[supervisorProtocolHeader]).toBe(supervisorProtocolVersion);
  });

  it("raises the classified provider failure the supervisor sent", async () => {
    const stub = await startStub(() => ({
      status: 404,
      body: { error: { kind: "not_found", message: "no snapshot is stored there" } },
    }));

    const failure = await clientFor(stub.origin)
      .restore(computer, { snapshotId: "snapshot-1", key: "snapshots/1" })
      .then(
        () => {
          throw new Error("the call was expected to fail");
        },
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ComputerProviderError);
    expect((failure as ComputerProviderError).kind).toBe("not_found");
    expect((failure as ComputerProviderError).detail).toBe("no snapshot is stored there");
    expect((failure as ComputerProviderError).status).toBe(404);
  });

  it("keeps rate_limited and timed_out distinguishable across the wire", async () => {
    const stub = await startStub((request) =>
      request.path.endsWith("/exec")
        ? { status: 504, body: { error: { kind: "timed_out", message: "the command outran it" } } }
        : { status: 429, body: { error: { kind: "rate_limited", message: "back off" } } },
    );
    const client = clientFor(stub.origin);

    const limited = await client.ensure(computer).catch((error: unknown) => error);
    const timedOut = await client
      .exec({ computer, command: "sleep 5", timeoutMs: 1_000 })
      .catch((error: unknown) => error);

    expect((limited as ComputerProviderError).kind).toBe("rate_limited");
    expect((timedOut as ComputerProviderError).kind).toBe("timed_out");
  });

  it("reports a command result and a computer list through the same seam", async () => {
    const stub = await startStub((request) => {
      if (request.path.endsWith("/exec")) {
        return {
          status: 200,
          body: { result: { exitCode: 0, stdout: "hello", stderr: "" } },
        };
      }

      if (request.path.endsWith("/v1/computers")) {
        return {
          status: 200,
          body: {
            computers: [
              { computer: computer, state: "running", instanceId: "container-1" },
              { computer: { computerId: "computer-2", botId: "bot-2" }, state: "stopped" },
            ],
          },
        };
      }

      return undefined;
    });
    const client = clientFor(stub.origin);

    await expect(
      client.exec({ computer, command: "printf hello", timeoutMs: 1_000 }),
    ).resolves.toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
    await expect(client.list()).resolves.toEqual([
      { computer, state: "running", instanceId: "container-1" },
      { computer: { computerId: "computer-2", botId: "bot-2" }, state: "stopped" },
    ]);
  });

  it("calls reset and recover, which are supervisor compositions rather than provider primitives", async () => {
    const stub = await startStub(() => ({
      status: 200,
      body: { status: { computer, state: "running", instanceId: "container-2" } },
    }));
    const client = clientFor(stub.origin);

    await expect(client.reset(computer)).resolves.toMatchObject({ state: "running" });
    await expect(client.recover(computer)).resolves.toMatchObject({ state: "running" });
    expect(stub.requests.map((request) => request.path)).toEqual([
      "/v1/computers/reset",
      "/v1/computers/recover",
    ]);
  });

  it("classifies a refused process credential and an unconfigured supervisor as auth_failed", async () => {
    const stub = await startStub((request) =>
      request.path.endsWith("/status")
        ? { status: 401, body: { error: "unauthorized" } }
        : {
            status: 503,
            body: { error: { kind: "not_configured", message: "no service token is set" } },
          },
    );
    const client = clientFor(stub.origin);

    const refused = await client.ensure(computer).catch((error: unknown) => error);
    const unconfigured = await client.stop(computer).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ComputerProviderError);
    expect((refused as ComputerProviderError).kind).toBe("auth_failed");
    expect((unconfigured as ComputerProviderError).kind).toBe("auth_failed");
    expect((unconfigured as ComputerProviderError).detail).toBe("no service token is set");
  });

  it("refuses an answer larger than the shared cap instead of buffering it", async () => {
    const chunk = new Uint8Array(512 * 1024).fill(120);
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 4; index += 1) {
          controller.enqueue(chunk);
        }

        controller.close();
      },
    });
    const client = createSupervisorComputerProvider({
      baseUrl: "http://unreachable.invalid",
      token: "supervisor-token",
      fetch: async () => new Response(oversized, { status: 200 }),
    });

    const failure = await client.status(computer).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ComputerProviderError);
    expect((failure as Error).message).toMatch(/exceeds/);
  });

  it("treats a malformed or unclassified answer as a defect, not a lifecycle fact", async () => {
    const stub = await startStub((request) =>
      request.path.endsWith("/status")
        ? { status: 200, body: { status: { computer, state: "zombie" } } }
        : { status: 502, body: { message: "a proxy spoke" } },
    );
    const client = clientFor(stub.origin);

    await expect(client.status(computer)).rejects.not.toBeInstanceOf(ComputerProviderError);
    await expect(client.stop(computer)).rejects.toThrow(/status 502/);
  });

  it("classifies a transport timeout as timed_out and never names the token", async () => {
    const stub = await startStub(() => undefined);
    const client = createSupervisorComputerProvider({
      baseUrl: stub.origin,
      token: "supervisor-token",
      requestTimeoutMs: 25,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });

    const failure = await client.ensure(computer).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ComputerProviderError);
    expect((failure as ComputerProviderError).kind).toBe("timed_out");
    expect((failure as Error).message).not.toContain("supervisor-token");
  });
});
