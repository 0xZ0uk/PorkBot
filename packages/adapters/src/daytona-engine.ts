import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { SafeFetch } from "@porkbot/effect";

/**
 * The Daytona API client (slice 7.3, PRD decision 20).
 *
 * The cloud computer speaks Daytona's two REST surfaces the way the Docker
 * provider speaks the Engine API: a small, dependency-free client for the
 * control plane (`POST /sandbox`, start, stop, recover, delete, list) and for
 * the sandbox's toolbox (`/process/execute`, `/files/download`,
 * `/files/upload-v2`). This module is the transport: paths, bodies, bounded
 * reads and the service's own error envelope. It does not know the shared
 * failure vocabulary; it raises `DaytonaEngineError` carrying the status, the
 * service's `code` and its message, and `daytona-errors.ts` alone translates
 * those into `gone`, `not_found`, `rate_limited`, `timed_out` and
 * `auth_failed`.
 *
 * The wire protocol is the vendor's current REST API — plain JSON over HTTPS,
 * `Authorization: Bearer <key>` — not an SDK. The offline emulator speaks the
 * same paths, so what the tests exercise is what a deployment dials; the
 * transport is injected and defaults to the URL-safety module's `safeFetch`,
 * which refuses a plain-HTTP or non-public endpoint in a deployment while the
 * emulator's loopback transport is a test's own fetch.
 *
 * Error shape: `origin` says where the failure was observed — `http` for a
 * refusal the service wrote, `transport` for a connection that never
 * answered, `timeout` for a call that outran its budget, `protocol` for an
 * answer that broke the contract. `providerMessage` is the service's human
 * text; it is read by the classifier and by nothing else.
 */

export type DaytonaFailureOrigin = "http" | "transport" | "timeout" | "protocol";

export class DaytonaEngineError extends Error {
  readonly origin: DaytonaFailureOrigin;
  readonly status: number | undefined;
  readonly errorCode: string | undefined;
  readonly providerMessage: string | undefined;

  constructor(
    origin: DaytonaFailureOrigin,
    detail: string,
    options: {
      readonly status?: number | undefined;
      readonly errorCode?: string | undefined;
      readonly providerMessage?: string | undefined;
      readonly cause?: unknown;
    } = {},
  ) {
    super(`Daytona engine ${origin}: ${detail}`, { cause: options.cause });
    this.name = "DaytonaEngineError";
    this.origin = origin;
    this.status = options.status;
    this.errorCode = options.errorCode;
    this.providerMessage = options.providerMessage;
  }
}

/** The sandbox states Daytona reports; the seam reads only `state`. */
export const DAYTONA_SANDBOX_STATES = [
  "creating",
  "restoring",
  "destroyed",
  "destroying",
  "started",
  "stopped",
  "starting",
  "stopping",
  "error",
  "build_failed",
  "pending_build",
  "building_snapshot",
  "unknown",
  "pulling_snapshot",
  "archived",
  "archiving",
  "resizing",
  "snapshotting",
  "forking",
  "pausing",
  "paused",
  "resuming",
] as const;

export type DaytonaSandboxState = (typeof DAYTONA_SANDBOX_STATES)[number];

/** The fields of a sandbox this adapter reads; the API returns more. */
export interface DaytonaSandbox {
  readonly id: string;
  readonly name?: string | undefined;
  readonly state: DaytonaSandboxState;
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

export interface DaytonaCreateSandboxSpec {
  /** The image or snapshot the sandbox boots from. */
  readonly source: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Whole vCPUs; the provider rounds a fractional ceiling up. */
  readonly cpu: number;
  /** Memory in gibibytes. */
  readonly memory: number;
  /** Disk in gibibytes. */
  readonly disk: number;
}

export interface DaytonaExecResponse {
  readonly exitCode: number;
  /** Daytona's toolbox returns one combined output stream. */
  readonly result: string;
}

export interface DaytonaEngineOptions {
  /** The control plane's base URL, for example `https://app.daytona.io/api`. */
  readonly endpoint: string;
  /**
   * The toolbox base URL; the control plane's `/toolbox` by default. A
   * deployment against the hosted service points this at the proxy host the
   * vendor publishes, and a self-hosted deployment leaves it derived.
   */
  readonly toolboxUrl?: string | undefined;
  /** The API key; never a constructor argument read from a vendor variable. */
  readonly token: string;
  /** The default budget for one call, in milliseconds; a call may override it. */
  readonly requestTimeoutMs?: number | undefined;
  /** The largest JSON answer read into memory, in bytes. */
  readonly maxJsonBytes?: number | undefined;
  /** Injected for tests and the offline emulator; defaults to `safeFetch`. */
  readonly fetch: SafeFetch;
}

const defaultRequestTimeoutMs = 30_000;
const defaultMaxJsonBytes = 4_194_304;

interface ErrorEnvelope {
  readonly message?: unknown;
  readonly error?: unknown;
  readonly code?: unknown;
  readonly statusCode?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorEnvelope(value: unknown): {
  readonly message: string;
  readonly errorCode: string | undefined;
} {
  if (!isRecord(value)) {
    return { message: "", errorCode: undefined };
  }

  const envelope = value as ErrorEnvelope;
  const message =
    typeof envelope.message === "string"
      ? envelope.message
      : typeof envelope.error === "string"
        ? envelope.error
        : "";
  const errorCode = typeof envelope.code === "string" ? envelope.code : undefined;

  return { message, errorCode };
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  const declaredLength = declared === null ? Number.NaN : Number(declared);

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new DaytonaEngineError("protocol", `a response exceeded ${maxBytes} bytes`);
  }

  const reader = response.body?.getReader();

  if (reader === undefined) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DaytonaEngineError("protocol", `a response exceeded ${maxBytes} bytes`);
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/** Wraps a transport rejection as a timeout or an unreachable service. */
function transportFailure(error: unknown, detail: string): DaytonaEngineError {
  const timedOut =
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

  return new DaytonaEngineError(timedOut ? "timeout" : "transport", detail, { cause: error });
}

/** A multipart body that streams the file instead of buffering it. */
function multipartBody(stream: Readable, boundary: string, filename: string) {
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  async function* parts(): AsyncGenerator<Uint8Array> {
    yield prefix;

    for await (const chunk of stream) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    }

    yield suffix;
  }

  return Readable.toWeb(Readable.from(parts())) as ReadableStream<Uint8Array>;
}

export interface DaytonaEngine {
  createSandbox(spec: DaytonaCreateSandboxSpec, budgetMs?: number): Promise<DaytonaSandbox>;
  /** `undefined` when the service no longer holds the sandbox. */
  getSandbox(idOrName: string, budgetMs?: number): Promise<DaytonaSandbox | undefined>;
  listSandboxes(budgetMs?: number): Promise<readonly DaytonaSandbox[]>;
  startSandbox(idOrName: string, budgetMs?: number): Promise<DaytonaSandbox>;
  /** `undefined` when the sandbox left the service before it could be parked. */
  stopSandbox(idOrName: string, budgetMs?: number): Promise<DaytonaSandbox | undefined>;
  recoverSandbox(idOrName: string, budgetMs?: number): Promise<DaytonaSandbox>;
  /** Idempotent: deleting a sandbox that is already gone succeeds. */
  deleteSandbox(idOrName: string, budgetMs?: number): Promise<void>;
  exec(
    sandboxId: string,
    request: { readonly command: string; readonly cwd: string; readonly timeoutMs: number },
    budgetMs?: number,
  ): Promise<DaytonaExecResponse>;
  downloadFile(
    sandboxId: string,
    path: string,
    budgetMs?: number,
  ): Promise<{ readonly stream: Readable; readonly length: number | undefined } | undefined>;
  uploadFile(
    sandboxId: string,
    path: string,
    body: { readonly stream: Readable; readonly length: number },
    budgetMs?: number,
  ): Promise<void>;
  /** Removes one file from the sandbox; a missing file is not an error. */
  deleteFile(sandboxId: string, path: string, budgetMs?: number): Promise<void>;
}

export function createDaytonaEngine(options: DaytonaEngineOptions): DaytonaEngine {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const toolboxUrl = (options.toolboxUrl ?? `${endpoint}/toolbox`).replace(/\/+$/, "");
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const maxJsonBytes = options.maxJsonBytes ?? defaultMaxJsonBytes;
  const fetchImpl = options.fetch;

  function toolboxPath(sandboxId: string, suffix: string): string {
    return `${toolboxUrl}/${encodeURIComponent(sandboxId)}${suffix}`;
  }

  async function call(
    url: string,
    init: {
      readonly method: string;
      readonly json?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
      readonly budgetMs: number;
    },
  ): Promise<{ readonly response: Response; readonly text: string }> {
    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(init.json === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        signal: AbortSignal.timeout(init.budgetMs),
      });
    } catch (error) {
      throw transportFailure(error, `the call to ${url} could not be made`);
    }

    const text = await readBounded(response, maxJsonBytes).catch((error: unknown) => {
      if (error instanceof DaytonaEngineError) {
        throw error;
      }

      throw transportFailure(error, `the answer from ${url} could not be read`);
    });

    if (!response.ok) {
      const { message, errorCode } = errorEnvelope(parseJson(text));

      throw new DaytonaEngineError("http", `the call to ${url} was refused`, {
        status: response.status,
        errorCode,
        providerMessage: message,
      });
    }

    return { response, text };
  }

  function parseJson(text: string): unknown {
    if (text.trim() === "") {
      return undefined;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DaytonaEngineError("protocol", "a response was not JSON");
    }
  }

  function parseSandbox(value: unknown): DaytonaSandbox {
    if (!isRecord(value) || typeof value["id"] !== "string") {
      throw new DaytonaEngineError("protocol", "a sandbox record was malformed");
    }

    const state = value["state"];
    const name = value["name"];
    const labels = value["labels"];

    return {
      id: value["id"],
      state: (DAYTONA_SANDBOX_STATES as readonly string[]).includes(state as string)
        ? (state as DaytonaSandboxState)
        : "unknown",
      name: typeof name === "string" ? name : undefined,
      labels: isRecord(labels)
        ? Object.fromEntries(
            Object.entries(labels).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined,
    };
  }

  async function sandboxCall(
    path: string,
    method: string,
    json: unknown,
    budgetMs: number,
  ): Promise<DaytonaSandbox> {
    const { text } = await call(`${endpoint}${path}`, { method, json, budgetMs });

    return parseSandbox(parseJson(text));
  }

  return {
    async createSandbox(spec, budgetMs = requestTimeoutMs) {
      return await sandboxCall(
        "/sandbox",
        "POST",
        {
          image: spec.source,
          name: spec.name,
          labels: spec.labels,
          cpu: spec.cpu,
          memory: spec.memory,
          disk: spec.disk,
          // The supervisor's idle sweep owns parking, and only explicit
          // lifecycle calls may destroy a bot's machine.
          autoStopInterval: 0,
          autoDeleteInterval: 0,
        },
        budgetMs,
      );
    },

    async getSandbox(idOrName, budgetMs = requestTimeoutMs) {
      try {
        const { text } = await call(`${endpoint}/sandbox/${encodeURIComponent(idOrName)}`, {
          method: "GET",
          budgetMs,
        });

        return parseSandbox(parseJson(text));
      } catch (error) {
        if (error instanceof DaytonaEngineError && error.status === 404) {
          return undefined;
        }

        throw error;
      }
    },

    async listSandboxes(budgetMs = requestTimeoutMs) {
      const { text } = await call(`${endpoint}/sandbox`, { method: "GET", budgetMs });
      const parsed = parseJson(text);
      const items = isRecord(parsed) && Array.isArray(parsed["items"]) ? parsed["items"] : [];

      return items.map(parseSandbox);
    },

    async startSandbox(idOrName, budgetMs = requestTimeoutMs) {
      return await sandboxCall(
        `/sandbox/${encodeURIComponent(idOrName)}/start`,
        "POST",
        undefined,
        budgetMs,
      );
    },

    async stopSandbox(idOrName, budgetMs = requestTimeoutMs) {
      try {
        return await sandboxCall(
          `/sandbox/${encodeURIComponent(idOrName)}/stop`,
          "POST",
          undefined,
          budgetMs,
        );
      } catch (error) {
        // Parking a sandbox the service has already forgotten is the
        // idempotent answer, not a failure.
        if (error instanceof DaytonaEngineError && error.status === 404) {
          return undefined;
        }

        throw error;
      }
    },

    async recoverSandbox(idOrName, budgetMs = requestTimeoutMs) {
      return await sandboxCall(
        `/sandbox/${encodeURIComponent(idOrName)}/recover`,
        "POST",
        undefined,
        budgetMs,
      );
    },

    async deleteSandbox(idOrName, budgetMs = requestTimeoutMs) {
      try {
        await call(`${endpoint}/sandbox/${encodeURIComponent(idOrName)}`, {
          method: "DELETE",
          budgetMs,
        });
      } catch (error) {
        // Deleting a sandbox the service has already forgotten is the
        // idempotent answer, not a failure.
        if (error instanceof DaytonaEngineError && error.status === 404) {
          return;
        }

        throw error;
      }
    },

    async exec(sandboxId, request, budgetMs = requestTimeoutMs) {
      // The toolbox counts seconds; a budget of zero seconds would mean "no
      // limit" to it, so a sub-second command still gets one.
      const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1_000));
      const { text } = await call(toolboxPath(sandboxId, "/process/execute"), {
        method: "POST",
        json: { command: request.command, cwd: request.cwd, timeout: seconds },
        budgetMs: Math.max(budgetMs, request.timeoutMs + 5_000),
      });
      const parsed = parseJson(text);

      if (!isRecord(parsed) || typeof parsed["exitCode"] !== "number") {
        throw new DaytonaEngineError("protocol", "an exec answer was malformed");
      }

      return {
        exitCode: parsed["exitCode"],
        result: typeof parsed["result"] === "string" ? parsed["result"] : "",
      };
    },

    async downloadFile(sandboxId, path, budgetMs = requestTimeoutMs) {
      const url = `${toolboxPath(sandboxId, "/files/download")}?path=${encodeURIComponent(path)}`;
      let response: Response;

      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${options.token}` },
          signal: AbortSignal.timeout(budgetMs),
        });
      } catch (error) {
        throw transportFailure(error, `the download from ${url} could not be made`);
      }

      if (!response.ok) {
        const text = await readBounded(response, maxJsonBytes).catch(() => "");
        const { message, errorCode } = errorEnvelope(parseJson(text));

        // A file the caller asked for and did not find is `undefined`, so a
        // caller collecting an optional stream does not read a status.
        if (response.status === 404) {
          return undefined;
        }

        throw new DaytonaEngineError("http", "the file download was refused", {
          status: response.status,
          errorCode,
          providerMessage: message,
        });
      }

      if (response.body === null) {
        throw new DaytonaEngineError("protocol", "the file download carried no body");
      }

      const declared = response.headers.get("content-length");
      const length = declared === null ? undefined : Number(declared);

      return {
        stream: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        length: Number.isFinite(length) ? length : undefined,
      };
    },

    async uploadFile(sandboxId, path, body, budgetMs = requestTimeoutMs) {
      const boundary = `porkbot-${Date.now().toString(16)}`;
      const url = `${toolboxPath(sandboxId, "/files/upload-v2")}?path=${encodeURIComponent(path)}`;

      let response: Response;

      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody(body.stream, boundary, "home.tar"),
          duplex: "half",
          signal: AbortSignal.timeout(budgetMs),
        });
      } catch (error) {
        throw transportFailure(error, `the upload to ${url} could not be made`);
      }

      if (!response.ok) {
        const text = await readBounded(response, maxJsonBytes).catch(() => "");
        const { message, errorCode } = errorEnvelope(parseJson(text));

        throw new DaytonaEngineError("http", "the file upload was refused", {
          status: response.status,
          errorCode,
          providerMessage: message,
        });
      }

      await response.body?.cancel().catch(() => undefined);
    },

    async deleteFile(sandboxId, path, budgetMs = requestTimeoutMs) {
      try {
        await call(
          `${toolboxPath(sandboxId, "/files")}?path=${encodeURIComponent(path)}&recursive=true`,
          { method: "DELETE", budgetMs },
        );
      } catch (error) {
        // Removing a scratch file that is already gone is the idempotent
        // answer, not a failure.
        if (error instanceof DaytonaEngineError && error.status === 404) {
          return;
        }

        throw error;
      }
    },
  };
}
