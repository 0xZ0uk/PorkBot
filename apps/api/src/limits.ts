import type { Context, Env, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimitedErrorMessage } from "@porkbot/contracts";
import type { UserActor } from "@porkbot/db";
import { healthPath } from "@porkbot/health";

/**
 * Rate limits, body caps and connection caps in one module (PRD decision 9,
 * slice 4.4). The reference implementation had zero rate limiting anywhere;
 * what this module exists to prevent is a route added later that is silently
 * unlimited or unbounded, so it is built around three single places:
 *
 *   - One register. `routeRules(rpcPath)` names every route family and the
 *     budget it draws from. `installLimits` is the only place the middleware
 *     is installed, and a path the register does not know still draws the
 *     anonymous budget rather than none — fail-closed, not fail-open. A test
 *     over the contract tree and the Hono route list fails when a route has
 *     no rule.
 *   - One accounting. `createRateLimiter` owns the fixed window and
 *     `createStreamSlots` owns the connection count; the gate, the HTTP
 *     middleware and a future webhook guard all call the same object instead
 *     of keeping a second counter.
 *   - One answer. An RPC caller sees the contract's typed `RATE_LIMITED` with
 *     `retryAfterSeconds` and a `Retry-After` header; a plain-HTTP caller sees
 *     a 429 JSON body with the same header.
 *
 * Limits live in process memory on purpose: v1.0 is a single host with one API
 * process (PRD decision 32), so a shared store would add a dependency the
 * topology does not have. Every limit is configurable through
 * `limitsFromEnvironment`, and the README documents the variables and
 * defaults.
 */

/** The route families a policy can be attached to. */
export type RouteFamily = "probe" | "rpc" | "webhook" | "fallback";

/**
 * A route and the family whose budget it draws from. `method` uses Hono's
 * vocabulary, including `ALL`; `path` is a Hono pattern, where a trailing `/*`
 * matches the prefix and everything under it.
 */
export interface RouteRule {
  readonly method: string;
  readonly path: string;
  readonly family: RouteFamily;
}

/**
 * The rules the API installs. `rpcPath` is passed in rather than imported so
 * this module does not depend on the app that mounts it (and the app does not
 * depend on a second copy of its own path).
 */
export function routeRules(rpcPath: string): readonly RouteRule[] {
  return [
    { method: "GET", path: healthPath, family: "probe" },
    { method: "ALL", path: `${rpcPath}/*`, family: "rpc" },
  ];
}

/** The rule for a request, or undefined when the register does not know it. */
export function routeRuleFor(
  rules: readonly RouteRule[],
  method: string,
  path: string,
): RouteRule | undefined {
  return rules.find((rule) => matches(rule, method, path));
}

function matches(rule: RouteRule, method: string, path: string): boolean {
  if (rule.method !== "ALL" && rule.method !== method) {
    return false;
  }

  if (rule.path.endsWith("/*")) {
    const prefix = rule.path.slice(0, -1);
    return path === prefix.slice(0, -1) || path.startsWith(prefix);
  }

  return rule.path === path;
}

/** A per-minute request budget. The window is fixed at one minute. */
export interface RequestBudget {
  readonly requestsPerMinute: number;
}

/** A request budget plus a cap on responses held open at once. */
export interface PrincipalBudget extends RequestBudget {
  readonly maxConcurrentStreams: number;
}

/** The largest body a route family accepts, in bytes. */
export interface BodyBudget {
  readonly maxBodyBytes: number;
}

export interface LimitsConfig {
  /** Per actor: the default for an authenticated RPC call. */
  readonly authenticated: PrincipalBudget & BodyBudget;
  /** Per client address: public procedures, unmatched paths and public streams. */
  readonly anonymous: PrincipalBudget & BodyBudget;
  /** Per client address: inbound webhooks (PRD decision 24). */
  readonly webhook: RequestBudget & BodyBudget;
  /** Per client address: the health probe, kept apart so a 404 flood cannot starve it. */
  readonly probe: RequestBudget;
}

export const defaultLimits: LimitsConfig = {
  authenticated: {
    requestsPerMinute: 300,
    maxConcurrentStreams: 4,
    maxBodyBytes: 1_048_576,
  },
  anonymous: {
    requestsPerMinute: 60,
    maxConcurrentStreams: 1,
    maxBodyBytes: 65_536,
  },
  webhook: {
    requestsPerMinute: 120,
    maxBodyBytes: 262_144,
  },
  probe: {
    requestsPerMinute: 600,
  },
};

export interface LimitsOverrides {
  readonly authenticated?: Partial<LimitsConfig["authenticated"]>;
  readonly anonymous?: Partial<LimitsConfig["anonymous"]>;
  readonly webhook?: Partial<LimitsConfig["webhook"]>;
  readonly probe?: Partial<LimitsConfig["probe"]>;
}

/** The registered defaults with the caller's overrides applied on top. */
export function resolveLimits(overrides: LimitsOverrides = {}): LimitsConfig {
  return {
    authenticated: { ...defaultLimits.authenticated, ...overrides.authenticated },
    anonymous: { ...defaultLimits.anonymous, ...overrides.anonymous },
    webhook: { ...defaultLimits.webhook, ...overrides.webhook },
    probe: { ...defaultLimits.probe, ...overrides.probe },
  };
}

/**
 * The variables that configure limits, read once at startup by `main.ts`.
 * An unset or blank variable takes its default; anything that is not a
 * positive integer fails startup rather than silently guarding with a number
 * nobody chose, the same direction `LOG_LEVEL` refuses an unknown level.
 */
export function limitsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): LimitsConfig {
  return {
    authenticated: {
      requestsPerMinute: limitFromEnvironment(
        env,
        "PORKBOT_LIMIT_AUTHENTICATED_PER_MINUTE",
        defaultLimits.authenticated.requestsPerMinute,
      ),
      maxConcurrentStreams: limitFromEnvironment(
        env,
        "PORKBOT_LIMIT_MAX_STREAMS_PER_ACTOR",
        defaultLimits.authenticated.maxConcurrentStreams,
      ),
      maxBodyBytes: limitFromEnvironment(
        env,
        "PORKBOT_LIMIT_MAX_BODY_BYTES",
        defaultLimits.authenticated.maxBodyBytes,
      ),
    },
    anonymous: {
      requestsPerMinute: limitFromEnvironment(
        env,
        "PORKBOT_LIMIT_ANONYMOUS_PER_MINUTE",
        defaultLimits.anonymous.requestsPerMinute,
      ),
      maxConcurrentStreams: defaultLimits.anonymous.maxConcurrentStreams,
      maxBodyBytes: limitFromEnvironment(
        env,
        "PORKBOT_LIMIT_MAX_BODY_BYTES",
        defaultLimits.anonymous.maxBodyBytes,
      ),
    },
    webhook: {
      requestsPerMinute: limitFromEnvironment(
        env,
        "PORKBOT_LIMIT_WEBHOOK_PER_MINUTE",
        defaultLimits.webhook.requestsPerMinute,
      ),
      maxBodyBytes: limitFromEnvironment(
        env,
        "PORKBOT_LIMIT_MAX_WEBHOOK_BODY_BYTES",
        defaultLimits.webhook.maxBodyBytes,
      ),
    },
    probe: {
      requestsPerMinute: limitFromEnvironment(
        env,
        "PORKBOT_LIMIT_PROBE_PER_MINUTE",
        defaultLimits.probe.requestsPerMinute,
      ),
    },
  };
}

function limitFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }

  return value;
}

/**
 * The principal a budget is keyed by: an actor when there is one, the client
 * address otherwise. Stream slots key the same way, so opening many
 * connections cannot exhaust the slots a different actor's streams need.
 */
export interface LimitPrincipal {
  readonly key: string;
  readonly authenticated: boolean;
}

export function actorPrincipal(actor: UserActor): LimitPrincipal {
  return { key: `actor:${actor.spaceId}:${actor.userId}`, authenticated: true };
}

export function clientPrincipal(address: string): LimitPrincipal {
  return { key: `client:${address}`, authenticated: false };
}

export type RateLimitOutcome =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  /**
   * Counts one request against `bucket`/`key`. A fixed window is enough here:
   * the budget exists to stop a runaway client, not to shape traffic, and a
   * window boundary can at worst admit two windows' worth for an instant.
   */
  check(bucket: string, key: string, requestsPerMinute: number, now?: number): RateLimitOutcome;
}

export interface RateLimiterOptions {
  readonly windowMs?: number;
  readonly now?: () => number;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; startedAt: number }>();
  let checks = 0;

  function sweep(at: number): void {
    for (const [key, window] of windows) {
      if (at - window.startedAt >= windowMs) {
        windows.delete(key);
      }
    }
  }

  return {
    check(bucket, key, requestsPerMinute, at = now()) {
      // Rotating keys (an attacker changing addresses) must not grow the map
      // without bound, so stale windows are dropped as the limiter is used.
      checks += 1;

      if (checks % 1_000 === 0) {
        sweep(at);
      }

      const counterKey = `${bucket}\u0000${key}`;
      const window = windows.get(counterKey);

      if (window === undefined || at - window.startedAt >= windowMs) {
        windows.set(counterKey, { count: 1, startedAt: at });
        return { allowed: true };
      }

      if (window.count < requestsPerMinute) {
        windows.set(counterKey, { count: window.count + 1, startedAt: window.startedAt });
        return { allowed: true };
      }

      const retryAfterMs = window.startedAt + windowMs - at;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)) };
    },
  };
}

export interface StreamSlot {
  readonly release: () => void;
}

export type StreamSlotOutcome =
  | { readonly opened: true; readonly slot: StreamSlot }
  | { readonly opened: false; readonly retryAfterSeconds: number };

export interface StreamSlots {
  /** Reserves one of `max` slots for `key`; the caller releases when the response ends. */
  acquire(key: string, max: number): StreamSlotOutcome;
}

export function createStreamSlots(): StreamSlots {
  const held = new Map<string, number>();

  return {
    acquire(key, max) {
      const count = held.get(key) ?? 0;

      if (count >= max) {
        // A slot cannot say when it will free, only that waiting is required.
        return { opened: false, retryAfterSeconds: 1 };
      }

      held.set(key, count + 1);
      let released = false;

      return {
        opened: true,
        slot: {
          release() {
            if (released) {
              return;
            }

            released = true;
            const current = held.get(key) ?? 0;

            if (current <= 1) {
              held.delete(key);
            } else {
              held.set(key, current - 1);
            }
          },
        },
      };
    },
  };
}

/**
 * The one accounting object the app, the gate and the middleware share. The
 * bucket name namespaces the counter, so the same client address can spend its
 * public budget and its probe budget without one draining the other.
 */
export interface RateLimits {
  readonly config: LimitsConfig;
  readonly rules: readonly RouteRule[];
  routeRuleFor(method: string, path: string): RouteRule | undefined;
  enforceRpc(principal: LimitPrincipal, now?: number): RateLimitOutcome;
  enforceRoute(
    family: Exclude<RouteFamily, "rpc">,
    clientKey: string,
    now?: number,
  ): RateLimitOutcome;
  acquireStream(principal: LimitPrincipal): StreamSlotOutcome;
  bodyCapBytes(family: RouteFamily): number;
}

export function createRateLimits(config: LimitsConfig, rules: readonly RouteRule[]): RateLimits {
  const limiter = createRateLimiter();
  const slots = createStreamSlots();

  return {
    config,
    rules,
    routeRuleFor: (method, path) => routeRuleFor(rules, method, path),
    enforceRpc(principal, now) {
      const budget = principal.authenticated ? config.authenticated : config.anonymous;

      return limiter.check(
        principal.authenticated ? "authenticated" : "anonymous",
        principal.key,
        budget.requestsPerMinute,
        now,
      );
    },
    enforceRoute(family, clientKey, now) {
      const budget =
        family === "probe"
          ? config.probe
          : family === "webhook"
            ? config.webhook
            : config.anonymous;

      return limiter.check(family, `client:${clientKey}`, budget.requestsPerMinute, now);
    },
    acquireStream(principal) {
      const budget = principal.authenticated ? config.authenticated : config.anonymous;

      return slots.acquire(principal.key, budget.maxConcurrentStreams);
    },
    bodyCapBytes: (family) => bodyCapBytes(config, family),
  };
}

/**
 * The body cap a family accepts. RPC takes the larger of the authenticated and
 * anonymous caps because the route is matched before a session exists; the
 * probe and unmatched families draw the anonymous cap.
 */
export function bodyCapBytes(config: LimitsConfig, family: RouteFamily): number {
  switch (family) {
    case "rpc":
      return Math.max(config.authenticated.maxBodyBytes, config.anonymous.maxBodyBytes);
    case "webhook":
      return config.webhook.maxBodyBytes;
    case "probe":
    case "fallback":
      return config.anonymous.maxBodyBytes;
  }
}

/**
 * The Hono variables this module reads. The app's context extends it with the
 * logger and request id; the principal is set by the RPC handler once the gate
 * has resolved an actor, and stays undefined for a non-RPC route.
 */
export interface LimitEnv extends Env {
  Variables: {
    principal: LimitPrincipal | undefined;
  };
}

export interface InstallLimitsOptions<E extends LimitEnv> {
  readonly config: LimitsConfig;
  readonly rules: readonly RouteRule[];
  /** The client address a request is keyed by when there is no actor. */
  readonly clientKey: (context: Context<E>) => string;
}

/**
 * The one installer. It registers, before any route:
 *
 *   - the wrapping middleware that spends a request budget (except on the RPC
 *     path, where the gate spends it after the session read so an actor and a
 *     client can have different budgets), and after the response is built
 *     holds a stream slot for any `text/event-stream` response — so the SSE
 *     slice gets a per-principal connection cap without asking for one;
 *   - a body cap per rule whose family accepts less than the largest cap, and
 *     a global cap at that largest value, so no route can buffer more than the
 *     configured maximum.
 *
 * Returns the shared accounting object so the gate can spend the RPC budget
 * with the actor it resolved.
 */
export function installLimits<E extends LimitEnv>(
  app: Hono<E>,
  options: InstallLimitsOptions<E>,
): RateLimits {
  const limits = createRateLimits(options.config, options.rules);
  const caps = new Map<RouteFamily, number>(
    (["probe", "rpc", "webhook", "fallback"] as const).map((family) => [
      family,
      bodyCapBytes(options.config, family),
    ]),
  );
  const largestCap = Math.max(...caps.values());

  app.use("*", async (context, next) => {
    const family = limits.routeRuleFor(context.req.method, context.req.path)?.family ?? "fallback";

    if (family !== "rpc") {
      const outcome = limits.enforceRoute(family, options.clientKey(context));

      if (!outcome.allowed) {
        return httpRateLimited(context, outcome.retryAfterSeconds);
      }
    }

    await next();

    const response = context.res;

    if (!isEventStream(response)) {
      return;
    }

    const principal = context.get("principal") ?? clientPrincipal(options.clientKey(context));
    const outcome = limits.acquireStream(principal);

    if (!outcome.opened) {
      await response.body?.cancel();
      context.res = rateLimitedResponse(context, outcome.retryAfterSeconds, family === "rpc");
      return;
    }

    context.res = withReleasedBody(response, outcome.slot.release);
    return;
  });

  for (const rule of options.rules) {
    const cap = caps.get(rule.family) ?? largestCap;

    if (cap < largestCap) {
      app.use(
        rule.path,
        bodyLimit({ maxSize: cap, onError: (context) => payloadTooLarge(context, cap) }),
      );
    }
  }

  app.use(
    "*",
    bodyLimit({ maxSize: largestCap, onError: (context) => payloadTooLarge(context, largestCap) }),
  );

  return limits;
}

/** The 429 a plain-HTTP surface answers a limited caller with. */
export function httpRateLimited<E extends LimitEnv>(
  context: Context<E>,
  retryAfterSeconds: number,
): Response {
  return context.json({ error: "rate_limited", retryAfterSeconds }, 429, {
    "retry-after": String(retryAfterSeconds),
  });
}

/**
 * A rate-limited response. An RPC caller gets the contract's error envelope,
 * so its typed client still throws `RATE_LIMITED` when the refusal happens
 * after the response started (a stream slot); every other caller gets JSON.
 */
function rateLimitedResponse<E extends LimitEnv>(
  context: Context<E>,
  retryAfterSeconds: number,
  rpc: boolean,
): Response {
  if (!rpc) {
    return httpRateLimited(context, retryAfterSeconds);
  }

  return new Response(
    JSON.stringify({
      defined: true,
      code: "RATE_LIMITED",
      status: 429,
      message: rateLimitedErrorMessage,
      data: { retryAfterSeconds },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}

function payloadTooLarge<E extends LimitEnv>(context: Context<E>, maxBytes: number): Response {
  return context.json({ error: "payload_too_large", maxBytes }, 413);
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

/**
 * Holds the slot until the body is done. Both a clean close and a client
 * disconnect release it, so a dropped connection frees the slot instead of
 * leaking it until the process restarts.
 */
function withReleasedBody(response: Response, release: () => void): Response {
  const body = response.body;

  if (body === null) {
    release();
    return response;
  }

  const reader = body.getReader();
  let released = false;

  function releaseOnce(): void {
    if (!released) {
      released = true;
      release();
    }
  }

  const held = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          releaseOnce();
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      releaseOnce();
      await reader.cancel(reason);
    },
  });

  return new Response(held, response);
}
