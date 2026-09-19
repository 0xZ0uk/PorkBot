import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isProviderFailure, snapshotChecksumPattern } from "@porkbot/adapter-kit";
import type { ComputerExecRequest, ComputerRef, ComputerSnapshot } from "@porkbot/adapter-kit";
import {
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
  /**
   * The configured kinds and the selection check (slice 9.4). Optional so the
   * lifecycle suites that build a server around a fake lifecycle need no
   * catalog; the two selection routes then answer `not_configured` rather than
   * inventing an availability answer.
   */
  readonly providers?:
    | {
        readonly defaultKind: string;
        readonly kinds: readonly string[];
        readonly validate: (kind: string) => Promise<{
          readonly kind: string;
          readonly available: boolean;
          readonly failure: string | null;
        }>;
      }
    | undefined;
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

function execRequestOf(body: unknown, maxExecTimeoutMs: number): ComputerExecRequest {
  const record = requireRecord(body, "the exec request");
  const command = requireString(record, "command", "the exec request");
  const timeoutMs = record["timeoutMs"];

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

  return { computer: computerOf(body), command, timeoutMs };
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

    if (path === supervisorComputerRoutes.providers) {
      if (options.providers === undefined) {
        throw new SupervisorRequestError(
          503,
          "not_configured",
          "this supervisor was built without a provider catalog",
        );
      }

      sendJson(response, 200, {
        providers: { defaultKind: options.providers.defaultKind, kinds: options.providers.kinds },
      });
      return;
    }

    if (path === supervisorComputerRoutes.validate) {
      if (options.providers === undefined) {
        throw new SupervisorRequestError(
          503,
          "not_configured",
          "this supervisor was built without a provider catalog",
        );
      }

      const kind = requireString(
        requireRecord(body, "the validation request"),
        "kind",
        "the request",
      );

      sendJson(response, 200, { validation: await options.providers.validate(kind) });
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
