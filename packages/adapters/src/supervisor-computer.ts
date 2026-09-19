import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerState,
  ComputerStatus,
  ProviderFailureKind,
} from "@porkbot/adapter-kit";

import { PROVIDER_FAILURE_KINDS, snapshotChecksumPattern } from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";

/**
 * The supervisor transport (slice 7.1, PRD decision 20).
 *
 * The supervisor is the only process that holds the Docker socket, so a
 * process that needs a computer reaches it by speaking to the supervisor over
 * an authenticated internal HTTP surface instead of importing a provider. This
 * module is the client half of that boundary: it implements the
 * `ComputerProvider` seam on top of the wire, so the tool layer, the run
 * executor and the operator surface are unchanged whether a computer is an
 * emulator, a local container or a cloud instance. The supervisor names the
 * wire; `apps/supervisor` serves these exact paths and constants, so the two
 * halves cannot drift silently.
 *
 * Two credentials meet here and they are different things. The bearer token
 * this client sends is the process credential the deployment configures both
 * sides with — it never leaves the server side of the deployment. The
 * short-lived capability token the supervisor also accepts (reserved screen
 * paths) is minted per actor and per computer and is not this client's to
 * hold; no method here sends one.
 *
 * Failure mapping: a provider failure the supervisor classified crosses the
 * wire as `{ error: { kind, message } }` and is re-raised as the same
 * `ComputerProviderError`, so `gone`, `not_found`, `rate_limited`, `timed_out`
 * and `auth_failed` survive the boundary instead of degrading into a status
 * code a caller has to interpret. A refused process credential, or a
 * supervisor with none configured, is `auth_failed` too — the deployment
 * failed closed and no retry fixes it. A malformed answer or an unknown route
 * is a defect on this seam and stays an ordinary `Error`, because no lifecycle
 * decision should be made from it.
 */

/** Where the supervisor mounts the computer surface. */
export const supervisorComputerBasePath = "/v1/computers";

/**
 * The largest body either half will read, in each direction: a command or a
 * restore is kilobytes, and the cap is shared so the client refuses an
 * oversized answer with the same bound the server refuses an oversized
 * request. One constant, so the two cannot drift.
 */
export const supervisorMaxBodyBytes = 1_048_576;

/** The paths one computer's lifecycle is addressed by; the server serves these. */
export const supervisorComputerRoutes = {
  list: supervisorComputerBasePath,
  providers: `${supervisorComputerBasePath}/providers`,
  validate: `${supervisorComputerBasePath}/providers/validate`,
  ensure: `${supervisorComputerBasePath}/ensure`,
  status: `${supervisorComputerBasePath}/status`,
  stop: `${supervisorComputerBasePath}/stop`,
  reset: `${supervisorComputerBasePath}/reset`,
  recover: `${supervisorComputerBasePath}/recover`,
  exec: `${supervisorComputerBasePath}/exec`,
  snapshot: `${supervisorComputerBasePath}/snapshot`,
  restore: `${supervisorComputerBasePath}/restore`,
  destroy: `${supervisorComputerBasePath}/destroy`,
} as const;

/** The reserved screen routes, gated by a capability token rather than the service token. */
export const supervisorScreenRoutePatterns = {
  frames: `${supervisorComputerBasePath}/:computerId/frames`,
  input: `${supervisorComputerBasePath}/:computerId/input`,
} as const;

/** The header both credentials travel in, exactly as HTTP names it. */
export const supervisorAuthorizationHeader = "authorization";

/** What the client prefixes the service token with. */
export function supervisorBearer(token: string): string {
  return `Bearer ${token}`;
}

/** The protocol version the two halves agree on; a mismatch is refused loudly. */
export const supervisorProtocolHeader = "x-porkbot-supervisor-protocol";
export const supervisorProtocolVersion = "1";

/** The detailed response a provider failure crosses the wire as. */
export interface SupervisorErrorBody {
  readonly error: {
    readonly kind: ProviderFailureKind;
    readonly message: string;
  };
}

/** True when a parsed JSON value is the failure envelope this protocol defines. */
export function isSupervisorErrorBody(value: unknown): value is SupervisorErrorBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const error = (value as Record<string, unknown>)["error"];

  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }

  const record = error as Record<string, unknown>;
  const kind = record["kind"];

  return (
    typeof kind === "string" &&
    (PROVIDER_FAILURE_KINDS as readonly string[]).includes(kind) &&
    typeof record["message"] === "string" &&
    record["message"].trim() !== ""
  );
}

export interface SupervisorComputerProviderOptions {
  /** The supervisor's origin: the compose service's address and port, from configuration. */
  readonly baseUrl: string;
  /** The process credential both processes are configured with. Never logged. */
  readonly token: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /**
   * The transport budget for a lifecycle call, in milliseconds. The default is
   * generous because a cold boot is a container start, not a request; a
   * command adds its own budget to this one, so the server's `timed_out`
   * classification arrives before the client gives up.
   */
  readonly requestTimeoutMs?: number | undefined;
}

/**
 * The supervisor client: the `ComputerProvider` seam plus the two lifecycle
 * operations that are compositions rather than provider primitives, and the
 * selection reads (slice 9.4) that name no computer at all.
 */
export interface SupervisorComputerProvider extends ComputerProvider {
  /** Destroy the machine and bring a clean one up; the home is what the provider defined it to be. */
  reset(computer: ComputerRef): Promise<ComputerStatus>;
  /** Adopt, start or re-provision whatever state the machine is in. */
  recover(computer: ComputerRef): Promise<ComputerStatus>;
  /** Every kind this deployment configured, and which one a bot with no selection uses. */
  providers(): Promise<SupervisorProviderCatalog>;
  /**
   * Ask one configured kind to prove it is reachable. Answers whether it is,
   * rather than throwing: an unavailable provider is the answer to the
   * question the operator asked, so the caller renders it instead of
   * unwinding. A kind this deployment never configured stays a defect.
   */
  validateProvider(kind: string): Promise<SupervisorProviderValidation>;
}

/** The kinds a supervisor deployment configured, and its default. */
export interface SupervisorProviderCatalog {
  /** The kind a bot with no selection runs on. */
  readonly defaultKind: string;
  /** Every kind a bot may select, in the order the deployment configured them. */
  readonly kinds: readonly string[];
}

/** What a selection check found for one kind. */
export interface SupervisorProviderValidation {
  readonly kind: string;
  readonly available: boolean;
  /** The shared vocabulary's kind when the provider refused, else `null`. */
  readonly failure: ProviderFailureKind | null;
}

/**
 * The transport budget for a lifecycle call, in milliseconds. A cold boot can
 * mean pulling an image and starting a container, so the default is a minute;
 * `reset` gets two. A command adds its own budget to this one, so the server's
 * `timed_out` classification arrives before the client gives up.
 */
const defaultRequestTimeoutMs = 60_000;
/** The slack a command's own budget gets before the transport aborts the wait. */
const execTransportSlackMs = 15_000;

function parseComputerState(value: unknown): ComputerState {
  if (value === "running" || value === "stopped" || value === "gone") {
    return value;
  }

  throw new Error(`the supervisor reported an unknown computer state: ${String(value)}`);
}

function parseComputerRef(value: unknown): ComputerRef {
  if (typeof value !== "object" || value === null) {
    throw new Error("the supervisor reported a malformed computer reference");
  }

  const record = value as Record<string, unknown>;
  const computerId = record["computerId"];
  const botId = record["botId"];
  const provider = record["provider"];

  if (typeof computerId !== "string" || typeof botId !== "string") {
    throw new Error("the supervisor reported a malformed computer reference");
  }

  if (provider !== undefined && (typeof provider !== "string" || provider.trim() === "")) {
    throw new Error("the supervisor reported a malformed computer reference");
  }

  return provider === undefined ? { computerId, botId } : { computerId, botId, provider };
}

/** Validates one status the wire carried; a drift fails here, not three layers up. */
export function parseComputerStatus(value: unknown): ComputerStatus {
  if (typeof value !== "object" || value === null) {
    throw new Error("the supervisor reported a malformed computer status");
  }

  const record = value as Record<string, unknown>;
  const instanceId = record["instanceId"];

  if (instanceId !== undefined && typeof instanceId !== "string") {
    throw new Error("the supervisor reported a malformed computer status");
  }

  return instanceId === undefined
    ? { computer: parseComputerRef(record["computer"]), state: parseComputerState(record["state"]) }
    : {
        computer: parseComputerRef(record["computer"]),
        state: parseComputerState(record["state"]),
        instanceId,
      };
}

/** Validates one configured-kind list the wire carried; a drift fails here. */
export function parseProviderCatalog(value: unknown): SupervisorProviderCatalog {
  if (typeof value !== "object" || value === null) {
    throw new Error("the supervisor reported a malformed provider catalog");
  }

  const record = value as Record<string, unknown>;
  const defaultKind = record["defaultKind"];
  const kinds = record["kinds"];

  if (
    typeof defaultKind !== "string" ||
    defaultKind.trim() === "" ||
    !Array.isArray(kinds) ||
    kinds.some((kind) => typeof kind !== "string" || kind.trim() === "")
  ) {
    throw new Error("the supervisor reported a malformed provider catalog");
  }

  return { defaultKind, kinds: kinds as string[] };
}

/** Validates one selection check; an unknown failure kind is a drift, not a guess. */
export function parseProviderValidation(value: unknown): SupervisorProviderValidation {
  if (typeof value !== "object" || value === null) {
    throw new Error("the supervisor reported a malformed provider validation");
  }

  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const available = record["available"];
  const failure = record["failure"];

  if (typeof kind !== "string" || kind.trim() === "" || typeof available !== "boolean") {
    throw new Error("the supervisor reported a malformed provider validation");
  }

  if (failure === null || failure === undefined) {
    return { kind, available, failure: null };
  }

  if (
    typeof failure !== "string" ||
    !(PROVIDER_FAILURE_KINDS as readonly string[]).includes(failure)
  ) {
    throw new Error("the supervisor reported an unknown provider failure kind");
  }

  return { kind, available, failure: failure as ProviderFailureKind };
}

function parseExecResult(value: unknown): ComputerExecResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("the supervisor reported a malformed command result");
  }

  const record = value as Record<string, unknown>;
  const exitCode = record["exitCode"];
  const stdout = record["stdout"];
  const stderr = record["stderr"];

  if (typeof exitCode !== "number" || typeof stdout !== "string" || typeof stderr !== "string") {
    throw new Error("the supervisor reported a malformed command result");
  }

  return { exitCode, stdout, stderr };
}

function parseSnapshot(value: unknown): ComputerSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new Error("the supervisor reported a malformed snapshot");
  }

  const record = value as Record<string, unknown>;
  const snapshotId = record["snapshotId"];
  const key = record["key"];
  const size = record["size"];
  const checksum = record["checksum"];

  if (
    typeof snapshotId !== "string" ||
    typeof key !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof checksum !== "string" ||
    !snapshotChecksumPattern.test(checksum)
  ) {
    throw new Error("the supervisor reported a malformed snapshot");
  }

  return { snapshotId, key, size, checksum };
}

function payloadOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    throw new Error(`the supervisor's response is missing "${key}"`);
  }

  const payload = (value as Record<string, unknown>)[key];

  if (payload === undefined) {
    throw new Error(`the supervisor's response is missing "${key}"`);
  }

  return payload;
}

/** The kind inside a refusal envelope, even one this client does not classify. */
function refusalKind(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const error = (value as Record<string, unknown>)["error"];

  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const kind = (error as Record<string, unknown>)["kind"];

  return typeof kind === "string" ? kind : undefined;
}

function refusalMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const error = (value as Record<string, unknown>)["error"];

  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const message = (error as Record<string, unknown>)["message"];

  return typeof message === "string" && message.trim() !== "" ? message : undefined;
}

/**
 * Reads a JSON answer under the same byte cap the server applies to requests.
 * A response with no declared length is streamed and abandoned the moment it
 * crosses the cap, so a misbehaving supervisor cannot make the API buffer an
 * unbounded body.
 */
async function readBoundedJson(
  response: Response,
  maxBytes: number,
  path: string,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  const declaredLength = declared === null ? Number.NaN : Number(declared);

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`the supervisor's answer to ${path} exceeds ${maxBytes} bytes`);
  }

  const reader = response.body?.getReader();

  if (reader === undefined) {
    return undefined;
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
      throw new Error(`the supervisor's answer to ${path} exceeds ${maxBytes} bytes`);
    }

    chunks.push(value);
  }

  if (size === 0) {
    return undefined;
  }

  const text = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Builds the client. Nothing is dialed here: a supervisor that is down is a
 * failure on the first call, classified by the transport rather than at boot,
 * so an API process can start before the supervisor does.
 */
export function createSupervisorComputerProvider(
  options: SupervisorComputerProviderOptions,
): SupervisorComputerProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function call(
    path: string,
    body: unknown,
    budgetMs: number,
  ): Promise<Record<string, unknown>> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        [supervisorAuthorizationHeader]: supervisorBearer(options.token),
        [supervisorProtocolHeader]: supervisorProtocolVersion,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budgetMs),
    };

    let response: Response;

    try {
      response = await doFetch(`${baseUrl}${path}`, init);
    } catch (error) {
      throw new ComputerProviderError(
        "timed_out",
        `the supervisor did not answer ${path} within ${budgetMs}ms`,
        undefined,
        { cause: error },
      );
    }

    const parsed = await readBoundedJson(response, supervisorMaxBodyBytes, path);

    if (!response.ok) {
      if (isSupervisorErrorBody(parsed)) {
        throw new ComputerProviderError(parsed.error.kind, parsed.error.message, response.status);
      }

      // The supervisor's process credential was refused, or it has none
      // configured. Both are the shared vocabulary's `auth_failed`: the
      // deployment failed closed, and retrying the same call cannot fix it.
      if (response.status === 401 || response.status === 403) {
        throw new ComputerProviderError(
          "auth_failed",
          "the supervisor refused this process's credential",
          response.status,
        );
      }

      if (refusalKind(parsed) === "not_configured") {
        throw new ComputerProviderError(
          "auth_failed",
          refusalMessage(parsed) ?? "the supervisor has no service token configured",
          response.status,
        );
      }

      throw new Error(
        `the supervisor refused ${path} with status ${response.status} and no classified error`,
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`the supervisor answered ${path} with a malformed body`);
    }

    return parsed as Record<string, unknown>;
  }

  async function statusOf(path: string, computer: ComputerRef, budgetMs: number) {
    return parseComputerStatus(payloadOf(await call(path, { computer }, budgetMs), "status"));
  }

  async function providers(): Promise<SupervisorProviderCatalog> {
    const body = await call(supervisorComputerRoutes.providers, {}, requestTimeoutMs);

    return parseProviderCatalog(payloadOf(body, "providers"));
  }

  async function validateProvider(kind: string): Promise<SupervisorProviderValidation> {
    const body = await call(supervisorComputerRoutes.validate, { kind }, requestTimeoutMs);

    return parseProviderValidation(payloadOf(body, "validation"));
  }

  return {
    async validate(): Promise<void> {
      // The seam's own `validate` has no kind to name, so it asks the
      // deployment's default — the kind a bot with no selection runs on.
      const catalog = await providers();
      const result = await validateProvider(catalog.defaultKind);

      if (!result.available) {
        throw new ComputerProviderError(
          result.failure ?? "not_found",
          `the default computer provider "${catalog.defaultKind}" is not available`,
        );
      }
    },

    providers,

    validateProvider,

    async ensure(computer): Promise<ComputerStatus> {
      return statusOf(supervisorComputerRoutes.ensure, computer, requestTimeoutMs);
    },

    async status(computer): Promise<ComputerStatus> {
      return statusOf(supervisorComputerRoutes.status, computer, requestTimeoutMs);
    },

    async stop(computer): Promise<ComputerStatus> {
      return statusOf(supervisorComputerRoutes.stop, computer, requestTimeoutMs);
    },

    async list(): Promise<readonly ComputerStatus[]> {
      const body = await call(supervisorComputerRoutes.list, {}, requestTimeoutMs);
      const listed = payloadOf(body, "computers");

      if (!Array.isArray(listed)) {
        throw new Error("the supervisor reported a malformed computer list");
      }

      return listed.map(parseComputerStatus);
    },

    async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
      const body = await call(
        supervisorComputerRoutes.exec,
        request,
        request.timeoutMs + execTransportSlackMs,
      );

      return parseExecResult(payloadOf(body, "result"));
    },

    async snapshot(computer): Promise<ComputerSnapshot> {
      return parseSnapshot(
        payloadOf(
          await call(supervisorComputerRoutes.snapshot, { computer }, requestTimeoutMs),
          "snapshot",
        ),
      );
    },

    async restore(computer, snapshot): Promise<ComputerStatus> {
      return parseComputerStatus(
        payloadOf(
          await call(supervisorComputerRoutes.restore, { computer, snapshot }, requestTimeoutMs),
          "status",
        ),
      );
    },

    async destroy(computer): Promise<void> {
      await call(supervisorComputerRoutes.destroy, { computer }, requestTimeoutMs);
    },

    async reset(computer): Promise<ComputerStatus> {
      return statusOf(supervisorComputerRoutes.reset, computer, requestTimeoutMs * 2);
    },

    async recover(computer): Promise<ComputerStatus> {
      return statusOf(supervisorComputerRoutes.recover, computer, requestTimeoutMs);
    },
  };
}
