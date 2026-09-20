import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { ComputerNetworkPlan } from "@porkbot/core";

/**
 * The Docker Engine API client (slice 7.2, PRD decision 20).
 *
 * The supervisor is the only process holding the Docker socket, and inside it
 * the Docker provider speaks the Engine API over that socket — the same HTTP
 * the `docker` CLI speaks, on the same unix socket — rather than shelling out
 * to a CLI the deployed image does not carry. This module is the transport:
 * paths, bodies, bounded reads and the daemon's own error envelope. It does
 * not know the shared failure vocabulary. It raises `DockerEngineError`
 * carrying the status, the JSON error code and the daemon's message, and
 * `docker-errors.ts` alone translates those into `gone`, `not_found`,
 * `rate_limited`, `timed_out` and `auth_failed`.
 *
 * The subset is exactly what computer lifecycle needs, and it is deliberately
 * small: version negotiation is skipped (the daemon accepts unversioned
 * paths), no client library is added, and every call carries a budget so a
 * wedged daemon cannot hold a supervisor request past its deadline. Reads are
 * bounded everywhere except the two archive directions, which stream, so a
 * large home is snapshotted without being buffered twice.
 *
 * Error shape: `origin` says where the failure was observed — `http` for a
 * refusal the daemon wrote, `stream` for a refusal the registry wrote into a
 * pull's `200 OK` body, `transport` for a socket that never answered, and
 * `timeout` for a call that outran its budget. `daemonMessage` is the daemon's
 * human text; it is read by the classifier and by nothing else.
 */

export type DockerFailureOrigin = "http" | "stream" | "transport" | "timeout" | "protocol";

export class DockerEngineError extends Error {
  readonly origin: DockerFailureOrigin;
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly daemonMessage: string | undefined;

  constructor(
    origin: DockerFailureOrigin,
    detail: string,
    options: {
      readonly status?: number | undefined;
      readonly code?: number | undefined;
      readonly daemonMessage?: string | undefined;
      readonly cause?: unknown;
    } = {},
  ) {
    super(`Docker engine ${origin}: ${detail}`, { cause: options.cause });
    this.name = "DockerEngineError";
    this.origin = origin;
    this.status = options.status;
    this.code = options.code;
    this.daemonMessage = options.daemonMessage;
  }
}

/** The endpoint the client dials; one of the two must name a socket. */
export interface DockerEngineOptions {
  /** The daemon's unix socket, for example `/var/run/docker.sock`. */
  readonly socketPath?: string | undefined;
  /** A TCP endpoint, for a daemon reached over the network or a test emulator. */
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  /** The default budget for one call, in milliseconds; a call may override it. */
  readonly requestTimeoutMs?: number | undefined;
  /** The largest JSON answer read into memory, in bytes. */
  readonly maxJsonBytes?: number | undefined;
}

export interface DockerContainerSummary {
  readonly Id: string;
  readonly Names?: readonly string[] | undefined;
  readonly Labels?: Readonly<Record<string, string>> | undefined;
  readonly State?: string | undefined;
}

export interface DockerContainerState {
  readonly Running?: boolean | undefined;
  readonly Status?: string | undefined;
  readonly Health?: { readonly Status?: string | undefined } | undefined;
  readonly ExitCode?: number | undefined;
}

export interface DockerContainerInspect {
  readonly Id: string;
  readonly Name?: string | undefined;
  readonly Config?: { readonly Labels?: Readonly<Record<string, string>> | undefined } | undefined;
  readonly State?: DockerContainerState | undefined;
}

/** The resource slice one container is created with. */
export interface DockerContainerResources {
  readonly nanoCpus: number;
  readonly memoryBytes: number;
  /** A write layer quota, only for daemons whose storage driver answers it. */
  readonly storageSize?: string | undefined;
  readonly pidsLimit: number;
  readonly tmpfsBytes?: number | undefined;
}

export interface DockerCreateContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly network: string;
  readonly workingDirectory: string;
  /** The host path or named volume mounted at the working directory; absent means no bind. */
  readonly homeVolume?: string | undefined;
  readonly user?: string | undefined;
  /** The container's command; `sleep infinity` when unset, which is what a sandbox runs. */
  readonly command?: readonly string[] | undefined;
  /** Container-level environment; a sidecar's configuration, never a sandbox's secrets. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
  /** Where `resources.tmpfsBytes` mounts; `/tmp` by default, the grants directory for a proxy. */
  readonly tmpfsPath?: string | undefined;
  /**
   * A container-level readiness probe. Absent, the daemon reports no health
   * and `ready` accepts the container the moment it is running, which is what
   * a sandbox wants. A sidecar whose server must be listening before a grant
   * can land carries one, so `ready` means "the proxy answers", not merely
   * "the process exists".
   */
  readonly healthcheck?: DockerHealthcheck | undefined;
  readonly resources: DockerContainerResources;
}

/** A Docker healthcheck, in the daemon's own shape. */
export interface DockerHealthcheck {
  readonly test: readonly string[];
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly startPeriodMs: number;
}

export interface DockerExecRequest {
  readonly containerId: string;
  readonly command: string;
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  /** The command's own budget; the transport budget adds a kill grace to it. */
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the retained output hit `maxOutputBytes`; the excess was drained and dropped. */
  readonly truncated: boolean;
}

/** One streamed file, used by the archive directions. */
export interface DockerStreamBody {
  readonly stream: Readable;
  readonly length: number;
}

export interface DockerEngine {
  ping(): Promise<void>;
  /** The daemon's declared storage driver, or an empty string when it says none. */
  storageDriver(): Promise<string>;
  imageExists(image: string, budgetMs?: number): Promise<boolean>;
  pullImage(image: string, budgetMs?: number): Promise<void>;
  ensureNetwork(plan: ComputerNetworkPlan, budgetMs?: number): Promise<void>;
  /**
   * Attaches a running or created container to a second network, optionally
   * under a DNS alias its peers resolve (slice 7.8: the proxy sidecar joins
   * the egress network this way while keeping the computer's isolated one).
   */
  connectNetwork(
    containerId: string,
    network: string,
    alias?: string,
    budgetMs?: number,
  ): Promise<void>;
  /**
   * Removes a network this provider created. Idempotent: a network that is
   * already gone is the answer destroy wants, and a network still holding
   * endpoints is the daemon's refusal, which surfaces as the failure it is.
   */
  removeNetwork(name: string, budgetMs?: number): Promise<void>;
  listContainers(
    labels: Readonly<Record<string, string>>,
    budgetMs?: number,
  ): Promise<readonly DockerContainerSummary[]>;
  inspectContainer(
    nameOrId: string,
    budgetMs?: number,
  ): Promise<DockerContainerInspect | undefined>;
  createContainer(spec: DockerCreateContainerSpec, budgetMs?: number): Promise<string>;
  startContainer(id: string, budgetMs?: number): Promise<void>;
  stopContainer(id: string, timeoutSeconds: number, budgetMs?: number): Promise<void>;
  removeContainer(
    id: string,
    options: { readonly force: boolean },
    budgetMs?: number,
  ): Promise<void>;
  removeVolume(name: string, budgetMs?: number): Promise<void>;
  /** Streams a tar of one path inside the container; the caller consumes and closes it. */
  getArchive(id: string, path: string, budgetMs?: number): Promise<DockerStreamBody>;
  /** Sends a tar into the container at a destination path. */
  putArchive(id: string, path: string, body: DockerStreamBody, budgetMs?: number): Promise<void>;
  exec(request: DockerExecRequest): Promise<DockerExecResult>;
}

interface DockerApiErrorBody {
  readonly message?: unknown;
  readonly code?: unknown;
}

function parseErrorBody(text: string): DockerApiErrorBody {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === "object" && parsed !== null ? (parsed as DockerApiErrorBody) : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Docker's exec stream frames one payload per header: [stream, 0, 0, 0, size]. */
const execFrameHeaderBytes = 8;

/**
 * Wraps a stream read failure so a dropped socket or an expired budget is a
 * transport or timeout on the shared vocabulary rather than an unclassified
 * protocol error. A failure the stream already classified passes through.
 */
function streamFailure(error: unknown, detail: string): DockerEngineError {
  if (error instanceof DockerEngineError) {
    return error;
  }

  const timedOut =
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

  return new DockerEngineError(timedOut ? "timeout" : "transport", detail, { cause: error });
}

async function readBounded(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;

    if (size > maxBytes) {
      response.destroy();
      throw new DockerEngineError("protocol", `a response exceeded ${maxBytes} bytes`);
    }

    chunks.push(bytes);
  }

  return Buffer.concat(chunks);
}

export function createDockerEngine(options: DockerEngineOptions = {}): DockerEngine {
  const socketPath = options.socketPath;
  const host = options.host;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxJsonBytes = options.maxJsonBytes ?? 1_048_576;

  if (socketPath === undefined && host === undefined) {
    throw new DockerEngineError("protocol", "a Docker endpoint needs a socket path or a host");
  }

  async function send(request: {
    readonly method: string;
    readonly path: string;
    readonly body?: string | Uint8Array | DockerStreamBody | undefined;
    readonly contentType?: string | undefined;
    readonly budgetMs: number;
    readonly accept: readonly number[];
  }): Promise<{ readonly status: number; readonly response: IncomingMessage }> {
    const headers: Record<string, string> = {};

    if (request.body !== undefined) {
      headers["content-type"] = request.contentType ?? "application/json";

      if (typeof request.body === "string" || request.body instanceof Uint8Array) {
        headers["content-length"] = String(Buffer.byteLength(request.body));
      } else {
        headers["content-length"] = String(request.body.length);
      }
    }

    return await new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(request.budgetMs);
      const clientRequest = http.request(
        {
          method: request.method,
          path: request.path,
          ...(socketPath === undefined ? { host, port: options.port ?? 2375 } : { socketPath }),
          headers,
          signal,
        },
        (response) => {
          const status = response.statusCode ?? 0;

          if (status >= 200 && status < 300) {
            resolve({ status, response });
            return;
          }

          if (request.accept.includes(status)) {
            resolve({ status, response });
            return;
          }

          void readBounded(response, 65_536)
            .then((bytes) => {
              const parsed = parseErrorBody(bytes.toString("utf8"));
              const message =
                typeof parsed.message === "string" ? parsed.message : bytes.toString("utf8");
              const code = typeof parsed.code === "number" ? parsed.code : undefined;

              reject(
                new DockerEngineError(
                  "http",
                  `the daemon refused ${request.method} ${request.path}`,
                  {
                    status,
                    code,
                    daemonMessage: message,
                  },
                ),
              );
            })
            .catch((error: unknown) => {
              reject(
                new DockerEngineError(
                  "http",
                  `the daemon refused ${request.method} ${request.path}`,
                  {
                    status,
                    cause: error,
                  },
                ),
              );
            });
        },
      );

      clientRequest.on("error", (error: NodeJS.ErrnoException) => {
        const timedOut = error.name === "AbortError" || error.name === "TimeoutError";

        reject(
          new DockerEngineError(
            timedOut ? "timeout" : "transport",
            `${request.method} ${request.path} failed`,
            {
              cause: error,
            },
          ),
        );
      });

      if (request.body === undefined) {
        clientRequest.end();
      } else if (typeof request.body === "string" || request.body instanceof Uint8Array) {
        clientRequest.end(request.body);
      } else {
        request.body.stream.pipe(clientRequest);
        request.body.stream.on("error", (error: unknown) => {
          clientRequest.destroy();

          reject(
            new DockerEngineError(
              "transport",
              `${request.method} ${request.path} body stream failed`,
              {
                cause: error,
              },
            ),
          );
        });
      }
    });
  }

  async function jsonCall<T>(
    method: string,
    path: string,
    body: unknown,
    budgetMs: number,
    allowNotFound = false,
  ): Promise<T | undefined> {
    const { status, response } = await send({
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
      budgetMs,
      accept: allowNotFound ? [404] : [],
    });

    if (status === 404) {
      response.resume();

      return undefined;
    }

    const bytes = await readBounded(response, maxJsonBytes);

    if (bytes.byteLength === 0) {
      return undefined;
    }

    return JSON.parse(bytes.toString("utf8")) as T;
  }

  async function readExecStream(
    response: IncomingMessage,
    maxOutputBytes: number,
  ): Promise<{
    readonly stdout: Buffer[];
    readonly stderr: Buffer[];
    readonly truncated: boolean;
  }> {
    let pending: Buffer = Buffer.alloc(0);
    let retained = 0;
    let truncated = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    try {
      for await (const chunk of response) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        pending = pending.byteLength === 0 ? bytes : Buffer.concat([pending, bytes]);

        while (pending.byteLength >= execFrameHeaderBytes) {
          const streamType = pending[0];
          const size = pending.readUInt32BE(4);

          if (size > 64 * 1024 * 1024) {
            response.destroy();
            throw new DockerEngineError("protocol", "an exec stream frame exceeded the bound", {
              status: undefined,
              daemonMessage: `frame size ${size}`,
            });
          }

          if (pending.byteLength < execFrameHeaderBytes + size) {
            break;
          }

          const payload = pending.subarray(execFrameHeaderBytes, execFrameHeaderBytes + size);
          pending = pending.subarray(execFrameHeaderBytes + size);

          if (retained + payload.byteLength > maxOutputBytes) {
            // The command keeps running; the excess is drained and dropped so a
            // full pipe cannot wedge it, and the result says it was truncated.
            truncated = true;
            continue;
          }

          retained += payload.byteLength;

          if (streamType === 2) {
            stderr.push(Buffer.from(payload));
          } else {
            stdout.push(Buffer.from(payload));
          }
        }
      }
    } catch (error) {
      throw streamFailure(error, "the exec stream failed before the command reported");
    }

    return { stdout, stderr, truncated };
  }

  return {
    async ping(): Promise<void> {
      const { response } = await send({
        method: "GET",
        path: "/_ping",
        budgetMs: requestTimeoutMs,
        accept: [],
      });

      response.resume();
    },

    async storageDriver(): Promise<string> {
      const info = await jsonCall<{ Driver?: unknown }>(
        "GET",
        "/info",
        undefined,
        requestTimeoutMs,
      );

      return typeof info?.Driver === "string" ? info.Driver : "";
    },

    async imageExists(image: string, budgetMs = requestTimeoutMs): Promise<boolean> {
      const { status, response } = await send({
        method: "GET",
        path: `/images/${encodeURIComponent(image)}/json`,
        budgetMs,
        accept: [404],
      });

      response.resume();

      return status !== 404;
    },

    async pullImage(image: string, budgetMs = requestTimeoutMs): Promise<void> {
      // The whole reference crosses in `fromImage`: the API accepts a name
      // carrying a tag or a digest, and a digest is the only pin the
      // dependency register allows, so splitting it would corrupt it.
      const query = new URLSearchParams({ fromImage: image });

      const { response } = await send({
        method: "POST",
        path: `/images/create?${query.toString()}`,
        budgetMs,
        accept: [],
      });

      // A pull failure is inside the stream: the daemon answers 200 and writes
      // `{"errorDetail":{"message":"..."}}` once the registry refuses. The
      // whole stream is read so a refusal is never mistaken for success.
      let buffered = "";

      try {
        for await (const chunk of response) {
          buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk as Uint8Array);

          let newline = buffered.indexOf("\n");

          while (newline !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);

            const refusal = pullRefusal(line);

            if (refusal !== undefined) {
              response.destroy();
              throw new DockerEngineError("stream", "the registry refused the pull", {
                daemonMessage: refusal,
              });
            }

            newline = buffered.indexOf("\n");
          }

          if (buffered.length > 1_048_576) {
            response.destroy();
            throw new DockerEngineError("protocol", "a pull progress line exceeded the bound");
          }
        }
      } catch (error) {
        throw streamFailure(error, "the pull stream failed before the pull finished");
      }

      const trailing = pullRefusal(buffered);

      if (trailing !== undefined) {
        throw new DockerEngineError("stream", "the registry refused the pull", {
          daemonMessage: trailing,
        });
      }
    },

    async ensureNetwork(plan: ComputerNetworkPlan, budgetMs = requestTimeoutMs): Promise<void> {
      const existing = await jsonCall<{ Internal?: unknown; Driver?: unknown; Options?: unknown }>(
        "GET",
        `/networks/${encodeURIComponent(plan.name)}`,
        undefined,
        budgetMs,
        true,
      );

      if (existing !== undefined) {
        assertNetworkMatchesPlan(plan, existing);
        return;
      }

      try {
        await jsonCall<{ Id?: unknown }>(
          "POST",
          "/networks/create",
          {
            Name: plan.name,
            Driver: plan.driver,
            Internal: plan.internal,
            Options: { "com.docker.network.bridge.gateway_mode_ipv4": plan.gatewayMode },
          },
          budgetMs,
        );
      } catch (error) {
        // Two ensures can race on first boot; the loser re-reads and verifies
        // instead of failing, and a network that is not the planned one is
        // refused by the check below.
        if (!(error instanceof DockerEngineError) || error.status !== 409) {
          throw error;
        }

        const created = await jsonCall<{ Internal?: unknown; Driver?: unknown; Options?: unknown }>(
          "GET",
          `/networks/${encodeURIComponent(plan.name)}`,
          undefined,
          budgetMs,
          true,
        );

        if (created === undefined) {
          throw error;
        }

        assertNetworkMatchesPlan(plan, created);
      }
    },

    async connectNetwork(containerId, network, alias, budgetMs = requestTimeoutMs) {
      await send({
        method: "POST",
        path: `/networks/${encodeURIComponent(network)}/connect`,
        body: JSON.stringify({
          Container: containerId,
          EndpointConfig: alias === undefined ? {} : { Aliases: [alias] },
        }),
        budgetMs,
        // A 403 here is the daemon's "container is already connected": the
        // attachment the caller wanted already exists, which is the
        // idempotent answer. A 404 still fails — a missing network or
        // container is not something to quietly skip.
        accept: [403],
      }).then(({ response }) => response.resume());
    },

    async removeNetwork(name, budgetMs = requestTimeoutMs) {
      await send({
        method: "DELETE",
        path: `/networks/${encodeURIComponent(name)}`,
        budgetMs,
        accept: [404],
      }).then(({ response }) => response.resume());
    },

    async listContainers(labels, budgetMs = requestTimeoutMs) {
      const filters = JSON.stringify({
        label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
      });
      const query = new URLSearchParams({ all: "1", filters });

      return (
        (await jsonCall<readonly DockerContainerSummary[]>(
          "GET",
          `/containers/json?${query.toString()}`,
          undefined,
          budgetMs,
        )) ?? []
      );
    },

    async inspectContainer(nameOrId, budgetMs = requestTimeoutMs) {
      return await jsonCall<DockerContainerInspect>(
        "GET",
        `/containers/${encodeURIComponent(nameOrId)}/json`,
        undefined,
        budgetMs,
        true,
      );
    },

    async createContainer(spec, budgetMs = requestTimeoutMs) {
      const tmpfs =
        spec.resources.tmpfsBytes === undefined
          ? undefined
          : { [spec.tmpfsPath ?? "/tmp"]: `size=${spec.resources.tmpfsBytes}` };
      const created = await jsonCall<{ Id?: unknown }>(
        "POST",
        `/containers/create?${new URLSearchParams({ name: spec.name }).toString()}`,
        {
          Image: spec.image,
          Cmd: spec.command === undefined ? ["sleep", "infinity"] : [...spec.command],
          WorkingDir: spec.workingDirectory,
          Labels: spec.labels,
          ...(spec.healthcheck === undefined
            ? {}
            : {
                Healthcheck: {
                  Test: [...spec.healthcheck.test],
                  Interval: spec.healthcheck.intervalMs * 1_000_000,
                  Timeout: spec.healthcheck.timeoutMs * 1_000_000,
                  Retries: spec.healthcheck.retries,
                  StartPeriod: spec.healthcheck.startPeriodMs * 1_000_000,
                },
              }),
          ...(spec.environment === undefined
            ? {}
            : {
                Env: Object.entries(spec.environment).map(([key, value]) => `${key}=${value}`),
              }),
          HostConfig: {
            NetworkMode: spec.network,
            ...(spec.homeVolume === undefined
              ? {}
              : { Binds: [`${spec.homeVolume}:${spec.workingDirectory}`] }),
            // A tmpfs is a host-config mount: the daemon silently ignores the
            // field anywhere else, which is how a "tmpfs" grant directory
            // quietly becomes a disk one.
            ...(tmpfs === undefined ? {} : { Tmpfs: tmpfs }),
            Memory: spec.resources.memoryBytes,
            // Equal to Memory on purpose: no swap headroom beyond the ceiling.
            MemorySwap: spec.resources.memoryBytes,
            NanoCpus: spec.resources.nanoCpus,
            PidsLimit: spec.resources.pidsLimit,
            RestartPolicy: { Name: "no" },
            // A real init reaps the zombies exec'd commands leave behind and
            // forwards the stop signal, so `docker stop` is a second rather
            // than the full grace period.
            Init: true,
            ...(spec.resources.storageSize === undefined
              ? {}
              : { StorageOpt: { size: spec.resources.storageSize } }),
          },
        },
        budgetMs,
      );

      if (created === undefined || typeof created.Id !== "string" || created.Id.trim() === "") {
        throw new DockerEngineError("protocol", "the daemon created a container without an id");
      }

      return created.Id;
    },

    async startContainer(id, budgetMs = requestTimeoutMs) {
      // 304 means it was already running, which is the idempotent answer.
      await send({
        method: "POST",
        path: `/containers/${encodeURIComponent(id)}/start`,
        budgetMs,
        accept: [304],
      }).then(({ response }) => response.resume());
    },

    async stopContainer(id, timeoutSeconds, budgetMs = requestTimeoutMs) {
      // 304 (already stopped) and 404 (already gone) are answers, not errors:
      // the provider re-reads the state and reports it.
      await send({
        method: "POST",
        path: `/containers/${encodeURIComponent(id)}/stop?${new URLSearchParams({ t: String(timeoutSeconds) }).toString()}`,
        budgetMs,
        accept: [304, 404],
      }).then(({ response }) => response.resume());
    },

    async removeContainer(id, options: { readonly force: boolean }, budgetMs = requestTimeoutMs) {
      await send({
        method: "DELETE",
        path: `/containers/${encodeURIComponent(id)}?${new URLSearchParams({
          force: options.force ? "1" : "0",
          v: "0",
        }).toString()}`,
        budgetMs,
        accept: [404],
      }).then(({ response }) => response.resume());
    },

    async removeVolume(name, budgetMs = requestTimeoutMs) {
      await send({
        method: "DELETE",
        path: `/volumes/${encodeURIComponent(name)}?force=1`,
        budgetMs,
        accept: [404],
      }).then(({ response }) => response.resume());
    },

    async getArchive(id, path, budgetMs = requestTimeoutMs) {
      const { response } = await send({
        method: "GET",
        path: `/containers/${encodeURIComponent(id)}/archive?${new URLSearchParams({ path }).toString()}`,
        budgetMs,
        accept: [],
      });
      const declared = Number(response.headers["content-length"] ?? Number.NaN);

      return { stream: response, length: Number.isFinite(declared) ? declared : 0 };
    },

    async putArchive(id, path, body, budgetMs = requestTimeoutMs) {
      const { response } = await send({
        method: "PUT",
        path: `/containers/${encodeURIComponent(id)}/archive?${new URLSearchParams({ path }).toString()}`,
        body,
        contentType: "application/x-tar",
        budgetMs,
        accept: [],
      });

      response.resume();
    },

    async exec(request: DockerExecRequest): Promise<DockerExecResult> {
      const created = await jsonCall<{ Id?: unknown }>(
        "POST",
        `/containers/${encodeURIComponent(request.containerId)}/exec`,
        {
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          WorkingDir: request.workingDirectory,
          Env: Object.entries(request.environment ?? {}).map(([key, value]) => `${key}=${value}`),
          Cmd: [
            "timeout",
            "-k",
            "1",
            "-s",
            "TERM",
            String(Math.max(1, Math.ceil(request.timeoutMs / 1000))),
            "/bin/sh",
            "-c",
            request.command,
          ],
        },
        requestTimeoutMs,
      );

      if (created === undefined || typeof created.Id !== "string") {
        throw new DockerEngineError("protocol", "the daemon created an exec without an id");
      }

      const execId = created.Id;
      // The command's budget plus the wrapper's kill grace; a client that
      // gives up earlier would report timed_out while the command still runs.
      const streamBudgetMs = request.timeoutMs + 5_000;
      const { response } = await send({
        method: "POST",
        path: `/exec/${encodeURIComponent(execId)}/start`,
        body: JSON.stringify({ Detach: false, Tty: false }),
        budgetMs: streamBudgetMs,
        accept: [],
      });

      const { stdout, stderr, truncated } = await readExecStream(response, request.maxOutputBytes);

      const inspected = await jsonCall<{ ExitCode?: unknown }>(
        "GET",
        `/exec/${encodeURIComponent(execId)}/json`,
        undefined,
        requestTimeoutMs,
      );
      const exitCode = typeof inspected?.ExitCode === "number" ? inspected.ExitCode : 0;

      return {
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
      };
    },
  };
}

function pullRefusal(line: string): string | undefined {
  const trimmed = line.trim();

  if (trimmed === "") {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const message = parsed["error"];
  const detail = parsed["errorDetail"];

  if (typeof message === "string" && message.trim() !== "") {
    return message;
  }

  if (
    isRecord(detail) &&
    typeof detail["message"] === "string" &&
    detail["message"].trim() !== ""
  ) {
    return detail["message"];
  }

  return undefined;
}

/** An adopted network must carry the same isolation the plan declared. */
function assertNetworkMatchesPlan(
  plan: ComputerNetworkPlan,
  existing: { readonly Internal?: unknown; readonly Driver?: unknown; readonly Options?: unknown },
): void {
  const options = isRecord(existing.Options) ? existing.Options : {};
  const gatewayMode = options["com.docker.network.bridge.gateway_mode_ipv4"];

  if (
    existing.Internal !== true ||
    existing.Driver !== plan.driver ||
    gatewayMode !== plan.gatewayMode
  ) {
    throw new DockerEngineError(
      "protocol",
      `the network "${plan.name}" already exists without the planned isolation and was not adopted`,
    );
  }
}
