import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { readTar, writeTar } from "./computer-archive.ts";

export { readTar, writeTar };

/**
 * The Docker Engine API emulator (slice 7.2).
 *
 * Every provider is tested against an emulator that speaks its real wire
 * protocol, with no daemon and no network. Docker's wire is HTTP over a unix
 * socket, so this is a fake Engine API on a unix socket in a temporary
 * directory: the shipped `createDockerEngine` client dials it exactly as it
 * dials `/var/run/docker.sock`, and `createDockerComputerProvider` is driven
 * through its real paths — create, start, inspect, stop, remove, exec, archive
 * in both directions, and the pull stream.
 *
 * The model is deliberately honest about the parts the provider depends on:
 * images must be pulled before a container can be created, containers carry
 * the labels the provider filters on, a named volume outlives its container
 * (which is what makes reset keep the home) and is removed only when the
 * volume API is asked, exec output crosses as the daemon's multiplexed frames
 * (`[stream, 0, 0, 0, size]`), and the archive endpoints carry a real ustar
 * tar rather than a private encoding, so the provider's snapshot/restore
 * round-trip is exercised over bytes a real daemon could have produced.
 *
 * Failure injection is scripted, not simulated: `failNext` makes the next
 * matching call answer a chosen status and message, `failNextPull` writes a
 * refusal into a `200 OK` pull body exactly as a registry does, and
 * `stallBoot` keeps a started container reporting `starting`. That is how the
 * classifier is tested end to end from the provider's own seam.
 */

/** One request the emulator received, oldest first, for assertions. */
export interface EmulatedDockerRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface EmulatedFailure {
  readonly method?: string | undefined;
  readonly pathIncludes?: string | undefined;
  readonly status: number;
  readonly message: string;
  readonly code?: number | undefined;
}

interface EmulatedContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly network: string | undefined;
  /** Every network the container is attached to, primary first. */
  readonly networks: Set<string>;
  readonly volume: { readonly name: string; readonly mountPath: string } | undefined;
  /** True when the create spec declared a healthcheck, so inspect reports health. */
  readonly healthchecked: boolean;
  state: "created" | "running" | "exited";
  /** When set, `start` reports `starting` until this wall-clock time. */
  readyAt: number;
  readonly files: Map<string, string>;
}

interface EmulatedNetwork {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly internal: boolean;
  readonly gatewayMode: string;
}

interface EmulatedExec {
  readonly id: string;
  readonly containerId: string;
  readonly command: readonly string[];
  readonly result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
}

interface ScriptedExec {
  readonly commandIncludes: string;
  readonly result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
}

export interface DockerEngineEmulatorOptions {
  /** The storage driver `/info` reports; `overlay2` by default. */
  readonly storageDriver?: string | undefined;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function dockerError(
  response: ServerResponse,
  status: number,
  message: string,
  code?: number,
): void {
  json(response, status, { message, ...(code === undefined ? {} : { code }) });
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

export class DockerEngineEmulator {
  readonly #server: Server;
  readonly #directory: string;
  readonly #socketPath: string;
  readonly #storageDriver: string;
  readonly #containers = new Map<string, EmulatedContainer>();
  readonly #images = new Set<string>();
  readonly #networks = new Map<string, EmulatedNetwork>();
  readonly #volumes = new Map<string, Map<string, string>>();
  readonly #execs = new Map<string, EmulatedExec>();
  readonly #requests: EmulatedDockerRequest[] = [];
  readonly #failures: EmulatedFailure[] = [];
  readonly #scripts: ScriptedExec[] = [];
  #pullRefusal: string | undefined;
  #nextId = 1;
  #nextExec = 1;

  private constructor(
    server: Server,
    directory: string,
    socketPath: string,
    storageDriver: string,
  ) {
    this.#server = server;
    this.#directory = directory;
    this.#socketPath = socketPath;
    this.#storageDriver = storageDriver;
  }

  static async start(options: DockerEngineEmulatorOptions = {}): Promise<DockerEngineEmulator> {
    const directory = await mkdtemp(path.join(tmpdir(), "porkbot-docker-emulator-"));
    const socketPath = path.join(directory, "docker.sock");
    const server = createServer();
    const emulator = new DockerEngineEmulator(
      server,
      directory,
      socketPath,
      options.storageDriver ?? "overlay2",
    );

    server.on("request", (request, response) => {
      void emulator.#route(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          dockerError(response, 500, `the emulator failed: ${String(error)}`);
        } else {
          response.destroy();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    return emulator;
  }

  /** The socket `createDockerEngine({ socketPath })` should dial. */
  get socketPath(): string {
    return this.#socketPath;
  }

  /** The endpoint for a client that prefers a base URL shape. */
  get endpoint(): { readonly socketPath: string } {
    return { socketPath: this.#socketPath };
  }

  /** Every request received, oldest first. */
  get requests(): readonly EmulatedDockerRequest[] {
    return this.#requests;
  }

  /** The images the daemon holds. */
  get imageNames(): readonly string[] {
    return [...this.#images];
  }

  /** Makes the next matching call fail with the daemon's own error envelope. */
  failNext(failure: EmulatedFailure): this {
    this.#failures.push(failure);
    return this;
  }

  /** Makes the next pull answer `200 OK` with the registry's refusal in the body. */
  failNextPull(message: string): this {
    this.#pullRefusal = message;
    return this;
  }

  /** Makes the next started container report `starting` for `ms`. */
  stallBoot(ms: number): this {
    this.#stallBootMs = ms;
    return this;
  }

  readonly #stalled = new Set<string>();
  #stallBootMs: number | undefined;

  /** Scripts one exec result, matched by a substring of the shell command. */
  scriptExec(
    commandIncludes: string,
    result: { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string },
  ): this {
    this.#scripts.push({
      commandIncludes,
      result: {
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      },
    });
    return this;
  }

  /** The files in the named volume, absolute paths to contents. */
  volumeFiles(name: string): ReadonlyMap<string, string> {
    return new Map(this.#volumes.get(name) ?? []);
  }

  /** Every volume by name, so a test can find the one a computer created. */
  volumes(): ReadonlyMap<string, ReadonlyMap<string, string>> {
    return new Map([...this.#volumes].map(([name, files]) => [name, new Map(files)]));
  }

  /** Every network the emulator was asked to create, with its isolation flags. */
  networks(): readonly {
    readonly name: string;
    readonly driver: string;
    readonly internal: boolean;
    readonly gatewayMode: string;
  }[] {
    return [...this.#networks.values()].map((network) => ({
      name: network.name,
      driver: network.driver,
      internal: network.internal,
      gatewayMode: network.gatewayMode,
    }));
  }

  /** Writes one file into the volume mounted at the given container path. */
  writeFile(absolutePath: string, content: string): this {
    for (const container of this.#containers.values()) {
      const volume = container.volume;

      if (volume !== undefined && absolutePath.startsWith(`${volume.mountPath}/`)) {
        container.files.set(absolutePath, content);
        return this;
      }
    }

    throw new Error(`no container volume is mounted above "${absolutePath}"`);
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();

    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
    await rm(this.#directory, { recursive: true, force: true });
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://docker");
    const method = request.method ?? "GET";
    const raw = await readBody(request);
    let body: unknown;

    // The archive upload is a tar, not JSON; it is handed to the archive path
    // as raw bytes and never parsed here.
    if (raw.byteLength > 0 && !url.pathname.endsWith("/archive")) {
      try {
        body = JSON.parse(raw.toString("utf8")) as unknown;
      } catch {
        body = raw.toString("utf8");
      }
    }

    this.#requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      body: url.pathname.endsWith("/archive") ? `<${raw.byteLength} bytes>` : body,
    });

    const injected = this.#takeFailure(method, url.pathname);

    if (injected !== undefined) {
      dockerError(response, injected.status, injected.message, injected.code);
      return;
    }

    await this.#dispatch(method, url, raw, body, response);
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

  async #dispatch(
    method: string,
    url: URL,
    raw: Buffer,
    body: unknown,
    response: ServerResponse,
  ): Promise<void> {
    const segments = url.pathname.split("/").filter((part) => part !== "");

    if (method === "GET" && url.pathname === "/_ping") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("OK");
      return;
    }

    if (method === "GET" && url.pathname === "/info") {
      json(response, 200, { Driver: this.#storageDriver });
      return;
    }

    if (segments[0] === "images" && segments.length === 3 && segments[2] === "json") {
      const image = decodeURIComponent(segments[1] ?? "");

      if (this.#images.has(image)) {
        json(response, 200, { Id: `sha256:${image}` });
      } else {
        dockerError(response, 404, `No such image: ${image}`);
      }

      return;
    }

    if (method === "POST" && url.pathname === "/images/create") {
      await this.#pull(url, response);
      return;
    }

    if (segments[0] === "networks") {
      this.#network(method, segments, url, body, response);
      return;
    }

    if (segments[0] === "containers") {
      await this.#container(method, segments, url, body, raw, response);
      return;
    }

    if (segments[0] === "exec") {
      this.#exec(method, segments, response);
      return;
    }

    if (segments[0] === "volumes") {
      if (method === "DELETE") {
        this.#volumes.delete(decodeURIComponent(segments[1] ?? ""));
        response.writeHead(204);
        response.end();
        return;
      }

      dockerError(response, 404, `page not found: ${url.pathname}`);
      return;
    }

    dockerError(response, 404, `page not found: ${url.pathname}`);
  }

  async #pull(url: URL, response: ServerResponse): Promise<void> {
    const image = url.searchParams.get("fromImage") ?? "";
    const tag = url.searchParams.get("tag");
    const reference = tag === null ? image : `${image}:${tag}`;

    response.writeHead(200, { "content-type": "application/json" });

    if (this.#pullRefusal !== undefined) {
      const message = this.#pullRefusal;
      this.#pullRefusal = undefined;
      response.end(`${JSON.stringify({ errorDetail: { message }, error: message })}\n`);
      return;
    }

    this.#images.add(reference);
    response.end(`${JSON.stringify({ status: `Pulled ${reference}` })}\n`);
  }

  #network(
    method: string,
    segments: readonly string[],
    url: URL,
    body: unknown,
    response: ServerResponse,
  ): void {
    if (method === "GET" && segments.length === 2) {
      const network = this.#networks.get(decodeURIComponent(segments[1] ?? ""));

      if (network === undefined) {
        dockerError(response, 404, `network ${decodeURIComponent(segments[1] ?? "")} not found`);
        return;
      }

      json(response, 200, {
        Id: network.id,
        Name: network.name,
        Driver: network.driver,
        Internal: network.internal,
        Options: { "com.docker.network.bridge.gateway_mode_ipv4": network.gatewayMode },
      });
      return;
    }

    if (method === "POST" && url.pathname === "/networks/create") {
      const record = body as
        { Name?: unknown; Driver?: unknown; Internal?: unknown; Options?: unknown } | undefined;
      const name = typeof record?.Name === "string" ? record.Name : "";

      if (this.#networks.has(name)) {
        dockerError(response, 409, `network with name ${name} already exists`);
        return;
      }

      const options =
        typeof record?.Options === "object" && record.Options !== null
          ? (record.Options as Record<string, unknown>)
          : {};
      const gatewayMode = options["com.docker.network.bridge.gateway_mode_ipv4"];
      const network: EmulatedNetwork = {
        id: `network-${this.#nextId++}`,
        name,
        driver: typeof record?.Driver === "string" ? record.Driver : "bridge",
        internal: record?.Internal === true,
        gatewayMode: typeof gatewayMode === "string" ? gatewayMode : "default",
      };

      this.#networks.set(name, network);
      json(response, 201, { Id: network.id, Warning: "" });
      return;
    }

    if (method === "POST" && segments.length === 3 && segments[2] === "connect") {
      const network = this.#networks.get(decodeURIComponent(segments[1] ?? ""));
      const record = body as { Container?: unknown } | undefined;
      const containerId = typeof record?.Container === "string" ? record.Container : "";
      const container = this.#find(containerId);

      if (network === undefined) {
        dockerError(response, 404, `network ${decodeURIComponent(segments[1] ?? "")} not found`);
        return;
      }

      if (container === undefined) {
        dockerError(response, 404, `No such container: ${containerId}`);
        return;
      }

      if (container.networks.has(network.name)) {
        dockerError(
          response,
          403,
          `container ${container.id} is already connected to network ${network.name}`,
        );
        return;
      }

      container.networks.add(network.name);
      response.writeHead(200);
      response.end();
      return;
    }

    dockerError(response, 404, `page not found: ${url.pathname}`);
  }

  /** Every network a container is attached to, for sidecar assertions. */
  attachmentsOf(nameOrId: string): readonly string[] {
    const container = this.#find(nameOrId);

    return container === undefined ? [] : [...container.networks];
  }

  /**
   * Every file the emulated container's writable layers hold, for assertions
   * about what a machine or a sidecar can and cannot read.
   */
  filesOf(nameOrId: string): ReadonlyMap<string, string> {
    return this.#find(nameOrId)?.files ?? new Map<string, string>();
  }

  /**
   * Registers a network without going through the plan guard, for the
   * deployment's egress network: a proxy sidecar's second leg is an ordinary
   * network, never a computer's isolated one.
   */
  addNetwork(name: string): void {
    this.#networks.set(name, {
      id: `network-${this.#nextId++}`,
      name,
      driver: "bridge",
      internal: false,
      gatewayMode: "nat",
    });
  }

  async #container(
    method: string,
    segments: readonly string[],
    url: URL,
    body: unknown,
    raw: Buffer,
    response: ServerResponse,
  ): Promise<void> {
    if (method === "GET" && url.pathname === "/containers/json") {
      const filters = parseFilters(url.searchParams.get("filters"));
      const summaries = [...this.#containers.values()]
        .filter((container) =>
          filters.every((filter) => {
            const separator = filter.indexOf("=");
            const key = separator === -1 ? filter : filter.slice(0, separator);
            const value = separator === -1 ? undefined : filter.slice(separator + 1);

            return value === undefined
              ? container.labels[key] !== undefined
              : container.labels[key] === value;
          }),
        )
        .map((container) => ({
          Id: container.id,
          Names: [`/${container.name}`],
          Labels: container.labels,
          State: container.state === "created" ? "created" : container.state,
        }));

      json(response, 200, summaries);
      return;
    }

    const nameOrId = decodeURIComponent(segments[1] ?? "");
    const container = this.#find(nameOrId);

    if (method === "POST" && url.pathname === "/containers/create") {
      this.#create(url, body, response);
      return;
    }

    if (container === undefined) {
      dockerError(response, 404, `No such container: ${nameOrId}`);
      return;
    }

    if (method === "GET" && segments[2] === "json") {
      json(response, 200, {
        Id: container.id,
        Name: `/${container.name}`,
        Config: { Labels: container.labels },
        State: this.#state(container),
      });
      return;
    }

    if (method === "POST" && segments[2] === "start") {
      if (container.state === "running") {
        response.writeHead(304);
        response.end();
        return;
      }

      container.state = "running";

      if (this.#stallBootMs !== undefined && !this.#stalled.has(container.id)) {
        container.readyAt = Date.now() + this.#stallBootMs;
        this.#stalled.add(container.id);
      }

      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "POST" && segments[2] === "stop") {
      if (container.state !== "running") {
        response.writeHead(304);
        response.end();
        return;
      }

      container.state = "exited";
      container.readyAt = 0;
      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "DELETE") {
      this.#containers.delete(container.id);
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname.endsWith("/archive")) {
      this.#archive(method, container, url, raw, response);
      return;
    }

    if (method === "POST" && segments[2] === "exec") {
      if (container.state !== "running") {
        dockerError(response, 409, `Container ${container.id} is not running`);
        return;
      }

      const record = body as { Cmd?: unknown } | undefined;
      const command = Array.isArray(record?.Cmd)
        ? record.Cmd.filter((part): part is string => typeof part === "string")
        : [];
      const shell = command.at(-1) ?? "";
      const scripted = this.#scripts.find((script) => shell.includes(script.commandIncludes));
      const id = `exec-${this.#nextExec++}`;

      this.#execs.set(id, {
        id,
        containerId: container.id,
        command,
        result: scripted?.result ?? { exitCode: 0, stdout: "", stderr: "" },
      });
      json(response, 201, { Id: id });
      return;
    }

    dockerError(response, 404, `page not found: ${url.pathname}`);
  }

  #create(url: URL, body: unknown, response: ServerResponse): void {
    const name = url.searchParams.get("name") ?? "";
    const record = body as
      | {
          readonly Image?: unknown;
          readonly Labels?: unknown;
          readonly Healthcheck?: unknown;
          readonly HostConfig?:
            { readonly Binds?: unknown; readonly NetworkMode?: unknown } | undefined;
        }
      | undefined;
    const image = typeof record?.Image === "string" ? record.Image : "";
    const imageReference = [...this.#images].find(
      (held) => held === image || held.startsWith(`${image}:`) || image.startsWith(`${held}:`),
    );

    if (imageReference === undefined) {
      dockerError(response, 404, `No such image: ${image}`);
      return;
    }

    if ([...this.#containers.values()].some((container) => container.name === name)) {
      dockerError(response, 409, `Conflict. The container name "/${name}" is already in use`);
      return;
    }

    const labels =
      typeof record?.Labels === "object" && record.Labels !== null
        ? Object.fromEntries(
            Object.entries(record.Labels as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    const binds = Array.isArray(record?.HostConfig?.Binds)
      ? record.HostConfig.Binds.filter((bind): bind is string => typeof bind === "string")
      : [];
    const [bind] = binds;
    const separator = bind?.indexOf(":") ?? -1;
    const volume =
      bind === undefined || separator === -1
        ? undefined
        : {
            name: bind.slice(0, separator),
            mountPath: bind.slice(separator + 1),
            files: this.#volumes.get(bind.slice(0, separator)) ?? new Map<string, string>(),
          };

    if (volume !== undefined && !this.#volumes.has(volume.name)) {
      this.#volumes.set(volume.name, volume.files);
    }

    const network =
      typeof record?.HostConfig?.NetworkMode === "string"
        ? record.HostConfig.NetworkMode
        : undefined;
    const id = `container-${this.#nextId++}`;
    this.#containers.set(id, {
      id,
      name,
      image,
      labels,
      network,
      networks: new Set(network === undefined ? [] : [network]),
      volume: volume === undefined ? undefined : { name: volume.name, mountPath: volume.mountPath },
      healthchecked: typeof record?.Healthcheck === "object" && record.Healthcheck !== null,
      state: "created",
      readyAt: 0,
      files: volume?.files ?? new Map<string, string>(),
    });
    json(response, 201, { Id: id, Warnings: [] });
  }

  #archive(
    method: string,
    container: EmulatedContainer,
    url: URL,
    raw: Buffer,
    response: ServerResponse,
  ): void {
    const mountPath = container.volume?.mountPath ?? "/";
    const target = url.searchParams.get("path") ?? "/";

    if (method === "GET") {
      if (!target.startsWith(mountPath)) {
        dockerError(
          response,
          404,
          `Could not find the file ${target} in container ${container.id}`,
        );
        return;
      }

      const base = path.posix.dirname(target);
      const entries = [...container.files.entries()]
        .filter(([file]) => file === target || file.startsWith(`${target}/`))
        .map(([file, content]) => ({
          name: path.posix.relative(base, file),
          content: Buffer.from(content, "utf8"),
        }));
      const archive = writeTar(entries);

      response.writeHead(200, {
        "content-type": "application/x-tar",
        "content-length": archive.byteLength,
      });
      response.end(archive);
      return;
    }

    if (method === "PUT") {
      for (const entry of readTar(raw)) {
        const file = path.posix.join(target, entry.name);
        container.files.set(file, Buffer.from(entry.content).toString("utf8"));
      }

      response.writeHead(200);
      response.end();
      return;
    }

    dockerError(response, 404, `page not found: ${url.pathname}`);
  }

  #exec(method: string, segments: readonly string[], response: ServerResponse): void {
    const id = decodeURIComponent(segments[1] ?? "");
    const exec = this.#execs.get(id);

    if (exec === undefined) {
      dockerError(response, 404, `No such exec instance: ${id}`);
      return;
    }

    if (method === "POST" && segments[2] === "start") {
      response.writeHead(200, { "content-type": "application/vnd.docker.raw-stream" });
      response.end(Buffer.concat([frame(1, exec.result.stdout), frame(2, exec.result.stderr)]));
      return;
    }

    if (method === "GET" && segments[2] === "json") {
      json(response, 200, { ExitCode: exec.result.exitCode, Running: false, Pid: 1234 });
      return;
    }

    dockerError(response, 404, `page not found: ${segments.join("/")}`);
  }

  #state(container: EmulatedContainer): {
    readonly Running: boolean;
    readonly Status: string;
    readonly Health?: { readonly Status: string };
  } {
    if (container.state !== "running") {
      return { Running: false, Status: container.state === "created" ? "created" : "exited" };
    }

    if (container.readyAt > Date.now()) {
      return { Running: true, Status: "running", Health: { Status: "starting" } };
    }

    // A container that declared a healthcheck reports one; the emulator cannot
    // run the probe, so a running container with a declared check is healthy
    // once its boot window (if any) has passed. That is the shape the provider
    // reads — `starting` until the check could have run, then `healthy`.
    if (container.healthchecked) {
      return { Running: true, Status: "running", Health: { Status: "healthy" } };
    }

    return { Running: true, Status: "running" };
  }

  #find(nameOrId: string): EmulatedContainer | undefined {
    for (const container of this.#containers.values()) {
      if (container.id === nameOrId || container.name === nameOrId) {
        return container;
      }
    }

    return undefined;
  }
}

function frame(streamType: 1 | 2, payload: string): Buffer {
  const content = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);

  header[0] = streamType;
  header.writeUInt32BE(content.byteLength, 4);
  return Buffer.concat([header, content]);
}

function parseFilters(filters: string | null): readonly string[] {
  if (filters === null) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(filters);

    if (typeof parsed !== "object" || parsed === null) {
      return [];
    }

    const labels = (parsed as Record<string, unknown>)["label"];

    return Array.isArray(labels)
      ? labels.filter((label): label is string => typeof label === "string")
      : [];
  } catch {
    return [];
  }
}
