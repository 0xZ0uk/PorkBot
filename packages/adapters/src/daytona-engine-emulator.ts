import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { ComputerProviderError } from "./computer-errors.ts";
import { runShellCommand } from "./computer-shell.ts";
import { createFileSystem, createShellWorld } from "./computer-shell-world.ts";
import type { FileSystemNode } from "./computer-shell-world.ts";

/**
 * The Daytona API emulator (slice 7.3).
 *
 * Every provider is tested against an emulator that speaks its real wire
 * protocol, with no network and no keys. Daytona's wire is plain HTTP JSON, so
 * this is a fake control plane and toolbox on loopback: the shipped
 * `createDaytonaEngine` client dials it exactly as it dials
 * `https://app.daytona.io/api`, and `createDaytonaComputerProvider` is driven
 * through its real paths — create, get, list, start, stop, recover, delete,
 * command execution, file download and multipart upload.
 *
 * The model is deliberately honest about the parts the provider depends on:
 * sandboxes carry the labels the provider filters on, a stopped sandbox keeps
 * its filesystem (which is what makes park-and-resume keep the agent home),
 * `process/execute` runs the shared bounded shell so command results are real
 * stdout and exit codes, and the toolbox file endpoints move the same bytes a
 * real sandbox would. Boot can be stalled so the bounded readiness wait is
 * exercised, and refusals can be scripted so the classifier is tested end to
 * end from the provider's own seam.
 *
 * The server is the vendor's documented shape: `Authorization: Bearer` on
 * every call, control-plane routes under `/api/sandbox`, toolbox routes under
 * `/api/toolbox/{sandboxId}`, the `{statusCode, message, error, code}` error
 * envelope, and a `408` when a command outruns the timeout it was given.
 */

/** One request the emulator received, oldest first, for assertions. */
export interface EmulatedDaytonaRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface EmulatedFailure {
  readonly method?: string | undefined;
  readonly pathIncludes?: string | undefined;
  readonly status: number;
  readonly message: string;
  readonly errorCode?: string | undefined;
}

interface EmulatedSandbox {
  readonly id: string;
  readonly name: string;
  state: "started" | "stopped" | "paused" | "archived" | "error";
  /** When a boot reported `starting` becomes `started`, in wall-clock ms. */
  readyAt: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly files: Map<string, FileSystemNode>;
}

export interface DaytonaEngineEmulatorOptions {
  /** The bearer token every request must present. */
  readonly token?: string | undefined;
  /** The agent home relative paths resolve against; `/home/agent` by default. */
  readonly home?: string | undefined;
}

export const DEFAULT_DAYTONA_HOME = "/home/agent";

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function daytonaError(
  response: ServerResponse,
  status: number,
  message: string,
  errorCode?: string,
): void {
  json(response, status, {
    statusCode: status,
    message,
    error: message,
    ...(errorCode === undefined ? {} : { code: errorCode }),
  });
}

async function readBody(request: IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;

    if (size > maxBytes) {
      request.destroy();
      throw new Error("the emulator's request body exceeded the bound");
    }

    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

/** The file part of a multipart body; the boundary is the body's first line. */
function multipartFile(body: Buffer): Buffer | undefined {
  const lineEnd = body.indexOf("\r\n");

  if (lineEnd === -1 || body[0] !== 0x2d || body[1] !== 0x2d) {
    return undefined;
  }

  const boundary = body.subarray(0, lineEnd);
  const headerEnd = body.indexOf("\r\n\r\n");

  if (headerEnd === -1) {
    return undefined;
  }

  const start = headerEnd + 4;
  const closing = body.indexOf(boundary, start);
  const end = closing === -1 ? body.length : Math.max(start, closing - 2);

  return body.subarray(start, end);
}

/** Creates every missing ancestor of a directory path. */
function ensureDirectory(files: Map<string, FileSystemNode>, target: string): void {
  let current = "";

  for (const part of target.split("/").filter((part) => part !== "")) {
    current += `/${part}`;

    if (files.get(current) === undefined) {
      files.set(current, { kind: "dir" });
    }
  }
}

export class DaytonaEngineEmulator {
  readonly #server: Server;
  readonly #token: string;
  readonly #home: string;
  readonly #sandboxes = new Map<string, EmulatedSandbox>();
  readonly #requests: EmulatedDaytonaRequest[] = [];
  readonly #failures: EmulatedFailure[] = [];
  #stallBootMs: number | undefined;
  #nextId = 1;

  private constructor(server: Server, token: string, home: string) {
    this.#server = server;
    this.#token = token;
    this.#home = home;
  }

  static async start(options: DaytonaEngineEmulatorOptions = {}): Promise<DaytonaEngineEmulator> {
    const server = createServer();
    const emulator = new DaytonaEngineEmulator(
      server,
      options.token ?? "wire-conformance-token",
      options.home ?? DEFAULT_DAYTONA_HOME,
    );

    server.on("request", (request, response) => {
      void emulator.#route(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          daytonaError(response, 500, `the emulator failed: ${String(error)}`);
        } else {
          response.destroy();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    return emulator;
  }

  /** The control-plane base URL a client should be configured with. */
  get endpoint(): string {
    const address = this.#server.address();

    if (address === null || typeof address === "string") {
      throw new Error("the emulator is not listening");
    }

    return `http://127.0.0.1:${String(address.port)}/api`;
  }

  /** The toolbox base URL; the client derives it from `endpoint` by default. */
  get toolboxUrl(): string {
    return `${this.endpoint}/toolbox`;
  }

  /** The bearer token both sides are configured with. */
  get token(): string {
    return this.#token;
  }

  /** Every request received, oldest first. */
  get requests(): readonly EmulatedDaytonaRequest[] {
    return this.#requests;
  }

  /** The state the emulator currently reports for a sandbox. */
  stateOf(idOrName: string): string | undefined {
    const sandbox = this.#find(idOrName);

    return sandbox === undefined ? undefined : this.#reportedState(sandbox);
  }

  /** The files of a sandbox, absolute paths to contents, for assertions. */
  filesOf(idOrName: string): ReadonlyMap<string, string> {
    const sandbox = this.#find(idOrName);

    return new Map(
      [...(sandbox?.files ?? new Map<string, FileSystemNode>())].map(([path, node]) => [
        path,
        node.kind === "file" ? new TextDecoder().decode(node.content) : "",
      ]),
    );
  }

  /** Writes one file, so a test can seed state without driving the shell. */
  writeFile(idOrName: string, path: string, content: string): this {
    const sandbox = this.#find(idOrName);

    if (sandbox === undefined) {
      throw new Error(`no sandbox named "${idOrName}"`);
    }

    sandbox.files.set(path, { kind: "file", content: new TextEncoder().encode(content) });
    return this;
  }

  /** Makes the next matching call fail with the service's own error envelope. */
  failNext(failure: EmulatedFailure): this {
    this.#failures.push(failure);
    return this;
  }

  /** Makes the next started sandbox report `starting` for `ms`. */
  stallBoot(ms: number): this {
    this.#stallBootMs = ms;
    return this;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();

    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  #find(idOrName: string): EmulatedSandbox | undefined {
    for (const sandbox of this.#sandboxes.values()) {
      if (sandbox.id === idOrName || sandbox.name === idOrName) {
        return sandbox;
      }
    }

    return undefined;
  }

  #reportedState(sandbox: EmulatedSandbox): string {
    if (sandbox.state === "started" && sandbox.readyAt > Date.now()) {
      return "starting";
    }

    return sandbox.state;
  }

  #publicSandbox(sandbox: EmulatedSandbox): Record<string, unknown> {
    return {
      id: sandbox.id,
      name: sandbox.name,
      state: this.#reportedState(sandbox),
      labels: sandbox.labels,
    };
  }

  #beginBoot(sandbox: EmulatedSandbox): void {
    sandbox.state = "started";
    sandbox.readyAt = this.#stallBootMs === undefined ? 0 : Date.now() + this.#stallBootMs;
  }

  #takeFailure(method: string, pathname: string): EmulatedFailure | undefined {
    const index = this.#failures.findIndex(
      (failure) =>
        (failure.method === undefined || failure.method === method) &&
        (failure.pathIncludes === undefined || pathname.includes(failure.pathIncludes)),
    );

    if (index === -1) {
      return undefined;
    }

    return this.#failures.splice(index, 1)[0];
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://daytona");
    const method = request.method ?? "GET";
    const raw = await readBody(request);
    let body: unknown;

    if (raw.byteLength > 0 && !(request.headers["content-type"] ?? "").includes("multipart")) {
      try {
        body = JSON.parse(raw.toString("utf8")) as unknown;
      } catch {
        body = raw.toString("utf8");
      }
    }

    this.#requests.push({ method, path: `${url.pathname}${url.search}`, body });

    if ((request.headers["authorization"] ?? "") !== `Bearer ${this.#token}`) {
      daytonaError(response, 401, "invalid api key", "UNAUTHORIZED");
      return;
    }

    const injected = this.#takeFailure(method, url.pathname);

    if (injected !== undefined) {
      daytonaError(response, injected.status, injected.message, injected.errorCode);
      return;
    }

    await this.#dispatch(method, url, raw, body, response);
  }

  async #dispatch(
    method: string,
    url: URL,
    raw: Buffer,
    body: unknown,
    response: ServerResponse,
  ): Promise<void> {
    const segments = url.pathname.split("/").filter((part) => part !== "");

    if (segments[0] !== "api") {
      daytonaError(response, 404, `page not found: ${url.pathname}`);
      return;
    }

    if (segments[1] === "sandbox") {
      this.#sandboxRoute(method, segments, body, response);
      return;
    }

    if (segments[1] === "toolbox") {
      await this.#toolboxRoute(method, segments, url, raw, body, response);
      return;
    }

    daytonaError(response, 404, `page not found: ${url.pathname}`);
  }

  #sandboxRoute(
    method: string,
    segments: readonly string[],
    body: unknown,
    response: ServerResponse,
  ): void {
    if (segments.length === 2) {
      if (method === "GET") {
        json(response, 200, {
          items: [...this.#sandboxes.values()].map((sandbox) => this.#publicSandbox(sandbox)),
          nextCursor: null,
        });
        return;
      }

      if (method === "POST") {
        this.#create(body, response);
        return;
      }
    }

    const idOrName = decodeURIComponent(segments[2] ?? "");
    const sandbox = this.#find(idOrName);

    if (sandbox === undefined) {
      daytonaError(response, 404, `Sandbox ${idOrName} not found`, "SANDBOX_NOT_FOUND");
      return;
    }

    if (method === "GET" && segments.length === 3) {
      json(response, 200, this.#publicSandbox(sandbox));
      return;
    }

    if (method === "DELETE" && segments.length === 3) {
      this.#sandboxes.delete(sandbox.id);
      json(response, 200, this.#publicSandbox(sandbox));
      return;
    }

    if (method === "POST" && segments.length === 4) {
      switch (segments[3]) {
        case "start":
          this.#beginBoot(sandbox);
          json(response, 200, this.#publicSandbox(sandbox));
          return;
        case "stop":
          if (sandbox.state !== "stopped") {
            sandbox.state = "stopped";
            sandbox.readyAt = 0;
          }
          json(response, 200, this.#publicSandbox(sandbox));
          return;
        case "pause":
          if (sandbox.state === "started") {
            sandbox.state = "paused";
            sandbox.readyAt = 0;
          }
          json(response, 200, this.#publicSandbox(sandbox));
          return;
        case "recover":
          this.#beginBoot(sandbox);
          json(response, 200, this.#publicSandbox(sandbox));
          return;
        case "archive":
          if (sandbox.state !== "archived") {
            sandbox.state = "archived";
            sandbox.readyAt = 0;
          }
          json(response, 200, this.#publicSandbox(sandbox));
          return;
        default:
          break;
      }
    }

    daytonaError(response, 404, `page not found: ${segments.join("/")}`);
  }

  #create(body: unknown, response: ServerResponse): void {
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const image = record["image"];
    const snapshot = record["snapshot"];

    if (typeof image !== "string" && typeof snapshot !== "string") {
      daytonaError(response, 400, "an image or a snapshot is required", "INVALID_REQUEST");
      return;
    }

    const name = typeof record["name"] === "string" ? record["name"] : undefined;
    const labels =
      typeof record["labels"] === "object" && record["labels"] !== null
        ? Object.fromEntries(
            Object.entries(record["labels"] as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    const id = `sandbox-${String(this.#nextId)}`;
    this.#nextId += 1;

    const sandbox: EmulatedSandbox = {
      id,
      name: name ?? id,
      state: "started",
      readyAt: 0,
      labels,
      files: createFileSystem(this.#home),
    };
    this.#beginBoot(sandbox);
    this.#sandboxes.set(id, sandbox);

    json(response, 200, this.#publicSandbox(sandbox));
  }

  async #toolboxRoute(
    method: string,
    segments: readonly string[],
    url: URL,
    raw: Buffer,
    body: unknown,
    response: ServerResponse,
  ): Promise<void> {
    const sandbox = this.#find(decodeURIComponent(segments[2] ?? ""));

    if (sandbox === undefined) {
      daytonaError(response, 404, `Sandbox ${segments[2] ?? ""} not found`, "SANDBOX_NOT_FOUND");
      return;
    }

    if (this.#reportedState(sandbox) !== "started") {
      daytonaError(response, 409, `Sandbox ${sandbox.id} is not running`, "SANDBOX_NOT_RUNNING");
      return;
    }

    const command = segments[3] ?? "";

    if (command === "process" && segments[4] === "execute" && method === "POST") {
      this.#execute(sandbox, body, response);
      return;
    }

    if (command === "files") {
      this.#files(method, segments, url, raw, sandbox, response);
      return;
    }

    daytonaError(response, 404, `page not found: ${url.pathname}`);
  }

  #execute(sandbox: EmulatedSandbox, body: unknown, response: ServerResponse): void {
    const record = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const command = record["command"];

    if (typeof command !== "string" || command.trim() === "") {
      daytonaError(response, 400, "a command is required", "INVALID_REQUEST");
      return;
    }

    const cwd = typeof record["cwd"] === "string" ? record["cwd"] : this.#home;
    const timeout = typeof record["timeout"] === "number" ? record["timeout"] : 10;
    const world = createShellWorld({
      files: sandbox.files,
      cwd,
      browser: () => ({ ok: false, error: "no browser is emulated on this machine" }),
    });

    try {
      const result = runShellCommand(world, command, {
        timeoutMs: timeout <= 0 ? Number.MAX_SAFE_INTEGER : timeout * 1_000,
      });

      json(response, 200, { exitCode: result.exitCode, result: result.stdout + result.stderr });
    } catch (error) {
      if (error instanceof ComputerProviderError && error.kind === "timed_out") {
        daytonaError(response, 408, error.detail, "PROCESS_TIMEOUT");
        return;
      }

      throw error;
    }
  }

  #files(
    method: string,
    segments: readonly string[],
    url: URL,
    raw: Buffer,
    sandbox: EmulatedSandbox,
    response: ServerResponse,
  ): void {
    const action = segments[4];
    const requested = url.searchParams.get("path") ?? this.#home;
    const path = this.#resolve(requested);

    if (action === "download" && method === "GET") {
      const node = sandbox.files.get(path);

      if (node === undefined || node.kind !== "file") {
        daytonaError(response, 404, `file not found: ${requested}`, "FILE_NOT_FOUND");
        return;
      }

      const bytes = Buffer.from(node.content);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.byteLength,
      });
      response.end(bytes);
      return;
    }

    if (action === "upload-v2" && method === "POST") {
      const content = multipartFile(raw);

      if (content === undefined) {
        daytonaError(response, 400, "a multipart file part is required", "INVALID_REQUEST");
        return;
      }

      const existing = sandbox.files.get(path);

      if (existing?.kind === "dir") {
        daytonaError(response, 400, `path '${requested}' is a directory`, "INVALID_FILE_PATH");
        return;
      }

      const parent = path.slice(0, path.lastIndexOf("/"));

      if (parent !== "") {
        ensureDirectory(sandbox.files, parent);
      }

      sandbox.files.set(path, { kind: "file", content: new Uint8Array(content) });
      json(response, 200, [{ path, name: path.split("/").at(-1) ?? path, type: "file" }]);
      return;
    }

    if (action === "folder" && method === "POST") {
      sandbox.files.set(path, { kind: "dir" });
      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "DELETE") {
      const node = sandbox.files.get(path);

      if (node === undefined) {
        daytonaError(response, 404, `file not found: ${requested}`, "FILE_NOT_FOUND");
        return;
      }

      for (const candidate of [...sandbox.files.keys()]) {
        if (candidate === path || candidate.startsWith(`${path}/`)) {
          sandbox.files.delete(candidate);
        }
      }

      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "GET") {
      const node = sandbox.files.get(path);

      if (node === undefined || node.kind !== "dir") {
        daytonaError(response, 404, `file not found: ${requested}`, "FILE_NOT_FOUND");
        return;
      }

      const prefix = path === "/" ? "/" : `${path}/`;
      const entries = [...sandbox.files.entries()]
        .filter(([candidate]) => candidate.startsWith(prefix) && candidate !== path)
        .map(([candidate, entry]) => ({
          name: candidate.slice(prefix.length),
          isDir: entry.kind === "dir",
          size: entry.kind === "file" ? entry.content.byteLength : 0,
          modTime: new Date(0).toISOString(),
        }))
        .filter((entry) => !entry.name.includes("/"));

      json(response, 200, entries);
      return;
    }

    daytonaError(response, 404, `page not found: ${segments.join("/")}`);
  }

  /** Folds a toolbox path (relative to the home) into an absolute one. */
  #resolve(input: string): string {
    const parts = input.startsWith("/") ? [] : this.#home.split("/").filter((part) => part !== "");

    for (const part of input.split("/")) {
      if (part === "" || part === ".") {
        continue;
      }

      if (part === "..") {
        parts.pop();
        continue;
      }

      parts.push(part);
    }

    return `/${parts.join("/")}`;
  }
}
