import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isProviderFailure, snapshotChecksumPattern } from "@porkbot/adapter-kit";
import type {
  ComputerExecRequest,
  ComputerProxyGrant,
  ComputerRef,
  ComputerSnapshot,
  CredentialProxyAdmin,
  ProxyUpstreamGrant,
} from "@porkbot/adapter-kit";
import {
  ComputerProviderError,
  FORBIDDEN_GRANT_HEADERS,
  supervisorAuthorizationHeader,
  supervisorComputerRoutes,
  supervisorMaxBodyBytes as wireMaxBodyBytes,
  supervisorProtocolHeader,
  supervisorProtocolVersion,
  supervisorScreenRoutePatterns,
} from "@porkbot/adapters";
import { timingSafeEqualBytes } from "@porkbot/effect";
import type { ScreenCapabilityCodec } from "@porkbot/effect";
import { createHealthListener } from "@porkbot/health";
import type { Logger } from "@porkbot/logging";
import type { ComputerLifecycle } from "./computer-lifecycle.ts";

/**
 * The supervisor's internal HTTP surface (slice 7.1, PRD decision 20).
 *
 * This is the only door to a computer. A caller (the API today, the worker
 * once its provider wiring lands) holds an
 * authenticated client for it; the Docker socket exists only in this process,
 * so "the API never receives an unrestricted Docker socket" is a property of
 * the deployment rather than a promise about a router. The surface is
 * deliberately not the oRPC contract: it is process-to-process, versioned by a
 * header, and speaks the same paths and envelope `@porkbot/adapters`' client
 * sends, so both halves are compiled against one set of constants.
 *
 * Two credentials guard two different things:
 *
 *   - the service token (constant-time compared) guards every lifecycle call;
 *     it is the process credential the deployment configures both sides with,
 *     and a deployment that has not configured one answers `not_configured`
 *     rather than falling open;
 *   - a short-lived screen capability guards the reserved frames and input
 *     paths. A browser could never hold the service token; when v1.1 ships
 *     screen watch, it presents a capability the API minted for one computer
 *     and one actor. v1.0 has no frames to send, so a valid capability reaches
 *     a deliberate `not_implemented` — the gate is shipped even though the
 *     stream behind it is not.
 *
 * Bodies are capped before they are read, a malformed body is refused before
 * it reaches a handler, and a provider failure keeps its shared vocabulary on
 * the wire (`gone`, `not_found`, `rate_limited`, `timed_out`, `auth_failed`)
 * so the client can re-raise the same classified error. Anything else — a
 * malformed response shape, a refused token, a protocol mismatch — is an
 * ordinary error on both sides: no lifecycle decision is made from it.
 */

/** The most a caller may ask one command to run; the tool layer declares far less. */
export const supervisorMaxExecTimeoutMs = 600_000;

/** The longest command string the supervisor will forward. */
export const supervisorMaxCommandLength = 65_536;

const providerFailureStatus = {
  gone: 410,
  not_found: 404,
  rate_limited: 429,
  timed_out: 504,
  auth_failed: 502,
} as const;

export interface SupervisorServerOptions {
  readonly lifecycle: ComputerLifecycle;
  /** The process credential; empty means the surface answers `not_configured`. */
  readonly serviceToken: string;
  /** Absent until the deployment configures a screen key; screen paths then refuse. */
  readonly screenTokens?: ScreenCapabilityCodec | undefined;
  readonly logger: Logger;
  readonly serviceName: string;
  /** Overridable for tests. */
  readonly maxBodyBytes?: number | undefined;
  readonly maxExecTimeoutMs?: number | undefined;
}

/** A refusal this module itself decided; the status and kind go out as written. */
class SupervisorRequestError extends Error {
  readonly status: number;
  readonly kind: string;

  constructor(status: number, kind: string, message: string) {
    super(message);
    this.name = "SupervisorRequestError";
    this.status = status;
    this.kind = kind;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, kind: string, message: string): void {
  sendJson(response, status, { error: { kind, message } });
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupervisorRequestError(400, "bad_request", `${what} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field];

  if (typeof value !== "string" || value.trim() === "") {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      `${what}.${field} must be a non-empty string`,
    );
  }

  return value;
}

function requireComputer(value: unknown): ComputerRef {
  const record = requireRecord(value, "computer");
  const provider = record["provider"];
  const computer: ComputerRef = {
    computerId: requireString(record, "computerId", "computer"),
    botId: requireString(record, "botId", "computer"),
  };

  if (provider === undefined) {
    return computer;
  }

  if (typeof provider !== "string" || provider.trim() === "") {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      "computer.provider must be a non-empty string when present",
    );
  }

  return { ...computer, provider };
}

function computerOf(body: unknown): ComputerRef {
  return requireComputer(requireRecord(body, "the request")["computer"]);
}

/** The largest one command's environment may be: a capability, by construction. */
export const supervisorMaxEnvironmentEntries = 32;
const maxEnvironmentNameLength = 128;
const maxEnvironmentValueLength = 8_192;

/** The grant shape's bounds; a credential header is bytes, not a document. */
const maxProxyUpstreams = 32;
const maxProxyUpstreamNameLength = 64;
const maxProxyHeaders = 32;
const maxProxyHeaderNameLength = 128;
const maxProxyHeaderValueLength = 8_192;

/**
 * The per-command environment, bounded and string-only. It is how a run hands
 * its sandbox the proxy endpoint and its short-lived capability — never a
 * credential — so the shape stays small and the refusal names the rule rather
 * than echoing a value.
 */
function environmentOf(
  record: Record<string, unknown>,
): Readonly<Record<string, string>> | undefined {
  const value = record["environment"];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      "environment must be an object of string values",
    );
  }

  const entries = Object.entries(value);

  if (entries.length > supervisorMaxEnvironmentEntries) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      `environment carries more than ${supervisorMaxEnvironmentEntries} entries`,
    );
  }

  const environment: Record<string, string> = {};

  for (const [name, entry] of entries) {
    if (
      name === "" ||
      name.length > maxEnvironmentNameLength ||
      typeof entry !== "string" ||
      entry.length > maxEnvironmentValueLength
    ) {
      throw new SupervisorRequestError(
        400,
        "bad_request",
        "environment names must be non-empty and values strings, within their bounds",
      );
    }

    environment[name] = entry;
  }

  return environment;
}

/**
 * One upstream a run's proxy grant names: a name, the origin it dials and the
 * headers the proxy injects. The origin must already be a bare HTTPS origin —
 * no path, no credentials, no plaintext — so a malformed grant is refused at
 * the door rather than written into a proxy that would only refuse it later.
 */
function proxyUpstreamOf(value: unknown): ProxyUpstreamGrant {
  const record = requireRecord(value, "a proxy upstream");
  const name = requireString(record, "name", "a proxy upstream");
  const origin = requireString(record, "origin", "a proxy upstream");

  if (name.length > maxProxyUpstreamNameLength) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      `a proxy upstream name exceeds ${maxProxyUpstreamNameLength} characters`,
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(origin);
  } catch {
    throw new SupervisorRequestError(400, "bad_request", "a proxy upstream origin is not a URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.origin !== origin
  ) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      "a proxy upstream origin must be a bare https origin with no credentials",
    );
  }

  const headers = record["headers"];

  if (headers === undefined) {
    return { name, origin };
  }

  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      "proxy upstream headers must be an object",
    );
  }

  const entries = Object.entries(headers);

  if (entries.length > maxProxyHeaders) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      `a proxy upstream carries more than ${maxProxyHeaders} headers`,
    );
  }

  const bounded: Record<string, string> = {};

  for (const [header, headerValue] of entries) {
    const lowered = header.toLowerCase();

    if (
      lowered === "" ||
      lowered.length > maxProxyHeaderNameLength ||
      typeof headerValue !== "string" ||
      headerValue.length > maxProxyHeaderValueLength ||
      /[\r\n]/.test(lowered) ||
      /[\r\n]/.test(headerValue) ||
      // The proxy's own allowlist decides what it may inject; a framing header
      // in a grant is refused here so the two halves cannot drift.
      (FORBIDDEN_GRANT_HEADERS as readonly string[]).includes(lowered)
    ) {
      throw new SupervisorRequestError(
        400,
        "bad_request",
        "proxy upstream headers must be injectable single-line strings within their bounds",
      );
    }

    bounded[lowered] = headerValue;
  }

  return { name, origin, headers: bounded };
}

function proxyGrantOf(value: unknown): ComputerProxyGrant {
  const record = requireRecord(value, "the proxy grant");
  const runId = requireString(record, "runId", "the proxy grant");
  const expiresAtSeconds = record["expiresAtSeconds"];
  const upstreams = record["upstreams"];

  if (runId.length > 128) {
    throw new SupervisorRequestError(400, "bad_request", "the proxy grant's run id is too long");
  }

  if (
    typeof expiresAtSeconds !== "number" ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= 0
  ) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      "the proxy grant needs a positive whole expiresAtSeconds",
    );
  }

  if (!Array.isArray(upstreams) || upstreams.length > maxProxyUpstreams) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      `the proxy grant needs at most ${maxProxyUpstreams} upstreams`,
    );
  }

  return { runId, expiresAtSeconds, upstreams: upstreams.map(proxyUpstreamOf) };
}

function execRequestOf(body: unknown, maxExecTimeoutMs: number): ComputerExecRequest {
  const record = requireRecord(body, "the exec request");
  const command = requireString(record, "command", "the exec request");
  const timeoutMs = record["timeoutMs"];
  const environment = environmentOf(record);

  if (command.length > supervisorMaxCommandLength) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      `the command exceeds ${supervisorMaxCommandLength} characters`,
    );
  }

  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > maxExecTimeoutMs
  ) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      `timeoutMs must be a whole number of milliseconds between 1 and ${maxExecTimeoutMs}`,
    );
  }

  return {
    computer: computerOf(body),
    command,
    timeoutMs,
    ...(environment === undefined ? {} : { environment }),
  };
}

function snapshotOf(value: unknown): ComputerSnapshot {
  const record = requireRecord(value, "snapshot");
  const size = record["size"];
  const checksum = record["checksum"];

  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof checksum !== "string" ||
    !snapshotChecksumPattern.test(checksum)
  ) {
    throw new SupervisorRequestError(
      400,
      "bad_request",
      "snapshot.size must be a whole number of bytes and snapshot.checksum a lowercase hex SHA-256",
    );
  }

  return {
    snapshotId: requireString(record, "snapshotId", "snapshot"),
    key: requireString(record, "key", "snapshot"),
    size,
    checksum,
  };
}

function bearerOf(request: IncomingMessage): string | undefined {
  const header = request.headers[supervisorAuthorizationHeader];

  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return undefined;
  }

  return header.slice("Bearer ".length);
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || presented === "") {
    return false;
  }

  return timingSafeEqualBytes(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const declared = request.headers["content-length"];
  const declaredLength = typeof declared === "string" ? Number(declared) : Number.NaN;

  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new SupervisorRequestError(413, "too_large", `the body exceeds ${maxBodyBytes} bytes`);
  }

  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;

      if (size > maxBodyBytes) {
        request.destroy();
        throw new SupervisorRequestError(
          413,
          "too_large",
          `the body exceeds ${maxBodyBytes} bytes`,
        );
      }

      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof SupervisorRequestError) {
      throw error;
    }

    throw new SupervisorRequestError(400, "bad_request", "the request body could not be read");
  }

  if (size === 0) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SupervisorRequestError(400, "bad_request", "the body is not valid JSON");
  }
}

function screenRouteMatcher(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(":computerId", "([^/]+)")}$`);
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SupervisorRequestError(400, "bad_request", "the computer id is not URL-encoded");
  }
}

/** Builds the supervisor's server; `main.ts` is the only caller that listens in production. */
export function createSupervisorServer(options: SupervisorServerOptions): Server {
  const logger = options.logger;
  const maxBodyBytes = options.maxBodyBytes ?? wireMaxBodyBytes;
  const maxExecTimeoutMs = options.maxExecTimeoutMs ?? supervisorMaxExecTimeoutMs;
  const health = createHealthListener({ service: options.serviceName });
  const framesPattern = screenRouteMatcher(supervisorScreenRoutePatterns.frames);
  const inputPattern = screenRouteMatcher(supervisorScreenRoutePatterns.input);

  function authorizeService(request: IncomingMessage): void {
    if (options.serviceToken === "") {
      throw new SupervisorRequestError(
        503,
        "not_configured",
        "this supervisor has no service token configured",
      );
    }

    if (!tokenMatches(bearerOf(request), options.serviceToken)) {
      throw new SupervisorRequestError(
        401,
        "unauthorized",
        "the service token is missing or wrong",
      );
    }
  }

  function checkProtocol(request: IncomingMessage): void {
    if (request.headers[supervisorProtocolHeader] !== supervisorProtocolVersion) {
      throw new SupervisorRequestError(
        400,
        "bad_request",
        `this supervisor speaks protocol version ${supervisorProtocolVersion}`,
      );
    }
  }

  /**
   * The proxy routes' door. A deployment that runs no proxy answers the shared
   * vocabulary's `not_found` rather than a 500, so a caller learns there is no
   * proxy instead of retrying a route that cannot work.
   */
  function requireProxyAdmin(): CredentialProxyAdmin {
    const proxy = options.lifecycle.proxy;

    if (proxy === undefined) {
      throw new ComputerProviderError(
        "not_found",
        "this deployment runs no credential proxy for this computer",
      );
    }

    return proxy;
  }

  /**
   * The reserved screen paths: capability token instead of the service token.
   *
   * The route tells this process which computer is being asked for, so that is
   * the coordinate it checks against the signed token; the actor and the space
   * are inside the signature and cannot be changed without the key. The API is
   * the only holder of the key and the only party that resolves a session, so
   * it decides which actor may hold a capability, and a stolen one grants that
   * actor's screen for that computer until it expires — nothing wider.
   */
  function authorizeScreen(request: IncomingMessage, computerId: string): void {
    if (options.screenTokens === undefined) {
      throw new SupervisorRequestError(
        503,
        "not_configured",
        "this supervisor has no screen capability key configured",
      );
    }

    const token = bearerOf(request);
    const verdict =
      token === undefined
        ? ({ valid: false, reason: "malformed" } as const)
        : options.screenTokens.verify(token, { computerId });

    if (verdict.valid) {
      return;
    }

    if (verdict.reason === "binding") {
      throw new SupervisorRequestError(
        403,
        "forbidden",
        "the screen capability is for another computer",
      );
    }

    throw new SupervisorRequestError(
      401,
      "unauthorized",
      `the screen capability is ${verdict.reason}`,
    );
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse, path: string) {
    const frames = framesPattern.exec(path);
    const input = inputPattern.exec(path);

    if (frames !== null || input !== null) {
      const computerId = decodeRouteParam((frames ?? input)?.[1] ?? "");
      authorizeScreen(request, computerId);

      if (request.method !== "GET" && request.method !== "POST") {
        throw new SupervisorRequestError(405, "method_not_allowed", "use GET or POST");
      }

      // The gate is shipped; the stream behind it is v1.1 work. A caller with
      // a valid capability reaches a deliberate, honest refusal rather than a
      // socket that pretends a frame is coming.
      throw new SupervisorRequestError(
        501,
        "not_implemented",
        "screen watch and takeover ship in v1.1; this path is reserved and guarded",
      );
    }

    if (request.method !== "POST") {
      throw new SupervisorRequestError(405, "method_not_allowed", "use POST");
    }

    authorizeService(request);
    checkProtocol(request);

    // Every route reads its body under the cap, list included: a request that
    // is too large is refused before its route is even considered, and the
    // socket is always drained.
    const body = await readBody(request, maxBodyBytes);

    if (path === supervisorComputerRoutes.list) {
      sendJson(response, 200, { computers: await options.lifecycle.list() });
      return;
    }

    if (path === supervisorComputerRoutes.ensure) {
      sendJson(response, 200, { status: await options.lifecycle.boot(computerOf(body)) });
      return;
    }

    if (path === supervisorComputerRoutes.status) {
      sendJson(response, 200, { status: await options.lifecycle.status(computerOf(body)) });
      return;
    }

    if (path === supervisorComputerRoutes.stop) {
      sendJson(response, 200, { status: await options.lifecycle.stop(computerOf(body)) });
      return;
    }

    if (path === supervisorComputerRoutes.reset) {
      sendJson(response, 200, { status: await options.lifecycle.reset(computerOf(body)) });
      return;
    }

    if (path === supervisorComputerRoutes.recover) {
      sendJson(response, 200, { status: await options.lifecycle.recover(computerOf(body)) });
      return;
    }

    if (path === supervisorComputerRoutes.exec) {
      sendJson(response, 200, {
        result: await options.lifecycle.exec(execRequestOf(body, maxExecTimeoutMs)),
      });
      return;
    }

    if (path === supervisorComputerRoutes.snapshot) {
      sendJson(response, 200, { snapshot: await options.lifecycle.snapshot(computerOf(body)) });
      return;
    }

    if (path === supervisorComputerRoutes.restore) {
      const record = requireRecord(body, "the restore request");

      sendJson(response, 200, {
        status: await options.lifecycle.restore(
          requireComputer(record["computer"]),
          snapshotOf(record["snapshot"]),
        ),
      });
      return;
    }

    if (path === supervisorComputerRoutes.destroy) {
      await options.lifecycle.destroy(computerOf(body));
      sendJson(response, 200, { destroyed: true });
      return;
    }

    if (path === supervisorComputerRoutes.proxyGrant) {
      const proxy = requireProxyAdmin();
      const record = requireRecord(body, "the proxy grant request");

      sendJson(response, 200, {
        endpoint: await proxy.grant(computerOf(body), proxyGrantOf(record["grant"])),
      });
      return;
    }

    if (path === supervisorComputerRoutes.proxyRevoke) {
      const proxy = requireProxyAdmin();
      const record = requireRecord(body, "the proxy revoke request");
      const runId = requireString(record, "runId", "the proxy revoke request");

      if (runId.length > 128) {
        throw new SupervisorRequestError(400, "bad_request", "the run id is too long");
      }

      await proxy.revoke(computerOf(body), runId);
      sendJson(response, 200, { revoked: true });
      return;
    }

    if (path === supervisorComputerRoutes.proxyEndpoint) {
      // A deployment with no proxy answers absent rather than refusing: the
      // question "where is the proxy?" has an honest answer, and a caller that
      // gets `undefined` knows not to hand its run a capability.
      const endpoint = await options.lifecycle.proxy?.endpoint(computerOf(body));

      sendJson(response, 200, { endpoint: endpoint ?? null });
      return;
    }

    throw new SupervisorRequestError(404, "not_found", `no route at ${path}`);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "/").split("?")[0] ?? "/";

    try {
      if (health(request, response)) {
        return;
      }

      await dispatch(request, response, path);
    } catch (error) {
      if (error instanceof SupervisorRequestError) {
        if (error.status >= 500) {
          logger.error("supervisor request failed", { path, kind: error.kind });
        } else {
          logger.warn("supervisor request refused", { path, kind: error.kind });
        }

        sendError(response, error.status, error.kind, error.message);
        return;
      }

      if (isProviderFailure(error)) {
        const detail = error.detail ?? "the provider failed without a detail";

        logger.warn("computer provider call failed", {
          path,
          kind: error.kind,
          detail,
        });
        sendError(response, providerFailureStatus[error.kind], error.kind, detail);
        return;
      }

      if (error instanceof RangeError) {
        logger.warn("supervisor request refused", { path, kind: "bad_request" });
        sendError(response, 400, "bad_request", error.message);
        return;
      }

      // An unmapped defect: the detail goes to the log, never to the client.
      logger.error("supervisor request failed", { path, error });
      sendError(response, 500, "internal", "the supervisor failed to handle the request");
    }
  }

  return createServer((request, response) => {
    void handle(request, response);
  });
}
