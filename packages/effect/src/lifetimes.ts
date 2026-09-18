import { Context } from "effect";
import type { Layer } from "effect";

/**
 * Effect layer lifetimes, made explicit (PRD decision 27).
 *
 * A process-scoped service — the database pool, a provider SDK client, the
 * process configuration — is a singleton: it is built once at boot and its
 * context is reused. Anything data-touching is scoped to a request or a run,
 * because a repository built with one actor's scope must never outlive that
 * actor, and a repository built with *no* actor is worse still.
 *
 * The rule is enforced where the mistake would be made. `processSingleton`
 * only accepts a layer whose provided services are all `ProcessScoped` and
 * whose own requirements are too, so a request-scoped repository — a layer
 * built from a `requestTag` — cannot be passed to it: the compile error is the
 * test. `requestScoped` is the other half, marking the layers that must be
 * rebuilt (and finalized) per request or per run.
 *
 * The brands are phantom: they exist in the type, never at runtime, so a tag
 * or a layer is still exactly what Effect expects when it is provided.
 */

/** The lifetime a service is allowed to have. */
export type LayerLifetime = "process" | "request";

export declare const processScopedBrand: unique symbol;
export declare const requestScopedBrand: unique symbol;

/** A service that may live for the process: pools, SDK clients, configuration. */
export interface ProcessScoped {
  readonly [processScopedBrand]: "process";
}

/** A service tied to one request or run: the actor, its repositories, a lease. */
export interface RequestScoped {
  readonly [requestScopedBrand]: "request";
}

/**
 * A service tag whose layer is a process singleton. `Context.Tag`'s identifier
 * is the tag itself, so a layer built from one carries the tag type in its
 * provided-services parameter and `processSingleton` can see the lifetime.
 */
export interface ProcessTag<Service>
  extends Context.Tag<ProcessTag<Service>, Service>, ProcessScoped {}

/** A service tag whose layer is rebuilt per request or per run. */
export interface RequestTag<Service>
  extends Context.Tag<RequestTag<Service>, Service>, RequestScoped {}

/**
 * Declares a process-scoped tag. Use it where a service's lifetime is the
 * process: `const Database = processTag<DatabaseShape>("@porkbot/db/Database")`.
 */
export function processTag<Service>(id: string): ProcessTag<Service> {
  return Context.GenericTag<ProcessTag<Service>, Service>(id) as ProcessTag<Service>;
}

/**
 * Declares a request- or run-scoped tag: `const Repositories =
 * requestTag<RepositoryShape>("@porkbot/db/Repositories")`. A layer for it is
 * constructed inside the request's `Layer.scoped`, so its finalizer runs when
 * the request ends.
 */
export function requestTag<Service>(id: string): RequestTag<Service> {
  return Context.GenericTag<RequestTag<Service>, Service>(id) as RequestTag<Service>;
}

export declare const processLayer: unique symbol;
export declare const requestLayer: unique symbol;

/**
 * A layer proven safe to build once and reuse for the process: every service
 * it provides is `ProcessScoped` and so is everything it requires.
 */
export interface ProcessLayer<A, E = never, R = never> extends Layer.Layer<A, E, R> {
  readonly [processLayer]: true;
}

/** A layer that must be built (and finalized) inside one request or run. */
export interface RequestLayer<A, E = never, R = never> extends Layer.Layer<A, E, R> {
  readonly [requestLayer]: true;
}

/**
 * Marks a layer as the process singleton it is built to be, and refuses at
 * compile time any layer that provides or requires a request-scoped service.
 * The returned layer is the same layer; the point is the constraint, so the
 * boot path cannot bake a scoped repository into a singleton.
 *
 * The constraint reads the layer as written. A request value captured into a
 * process layer by hand, or already provided away before this call, is a
 * deliberate act no type can see — what is refused is the accidental shape:
 * a repository (or the actor it was built from) reaching a boot-time layer.
 */
export function processSingleton<A extends ProcessScoped, E, R extends ProcessScoped>(
  layer: Layer.Layer<A, E, R>,
): ProcessLayer<A, E, R> {
  return layer as ProcessLayer<A, E, R>;
}

/**
 * Marks a layer as request-scoped. This is a marker, not a scoping mechanism:
 * build the layer with `Layer.scoped` so Effect acquires it when the request
 * scope opens and runs its finalizers when it closes, then wrap it here so the
 * lifetime is visible in the signature and a request-only tag cannot be
 * declared process-scoped by accident.
 */
export function requestScoped<A extends RequestScoped, E, R>(
  layer: Layer.Layer<A, E, R>,
): RequestLayer<A, E, R> {
  return layer as RequestLayer<A, E, R>;
}
