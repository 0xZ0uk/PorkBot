export const moduleInfo = {
  name: "@porkbot/effect",
  summary: "Shared Effect layers, service tags, typed errors and the transport error mapping.",
} as const;

// The typed errors the `Cause -> ORPCError` table maps. They are declared here,
// not beside their throw sites, so the mapping can name them without importing
// `@porkbot/db` (the module map keeps that edge out of this package). Every
// class is an Effect `Data.TaggedError`: throwable from promise code, catchable
// by tag in an Effect program, and keyable in the mapping table.
export {
  BlockedUrlError,
  CredentialMissingError,
  DeploymentSettingsConflictError,
  GateTimeoutError,
  LeaseLostError,
  NotFoundError,
  RunGoneError,
} from "./errors.ts";
export type { BlockedUrlReason, TypedError, TypedErrorTag } from "./errors.ts";

// The transport boundary (PRD decision 28): one table from every typed error to
// an oRPC code, one default row for an unmapped defect, and the mapping from an
// Effect `Cause`. Routers throw typed errors and never inspect one; the gate
// middleware calls `mapError`, and the API's error listener reads
// `boundaryReports` to decide what a redacted log line contains.
export { boundaryReports, errorMappings, mapCause, mapError, mappingFor } from "./mapping.ts";
export type {
  BoundaryError,
  BoundaryOptions,
  DeclaredError,
  DeclaredErrorLookup,
  ErrorMapping,
  MappedErrorCode,
} from "./mapping.ts";

// Layer lifetimes (PRD decision 27): process-scoped services are declared with
// `processTag` and only `processSingleton` can bless a boot-time singleton, so
// a request-scoped repository cannot be baked into one.
export { processSingleton, processTag, requestScoped, requestTag } from "./lifetimes.ts";
export type {
  LayerLifetime,
  ProcessLayer,
  ProcessScoped,
  ProcessTag,
  RequestLayer,
  RequestScoped,
  RequestTag,
} from "./lifetimes.ts";

// URL safety (slice 4.6, PRD decision 23). Every fetch of a user-supplied URL
// enters through `safeFetch`; the rules, the guarded lookup and the typed
// refusal live here so there is no second policy to drift from.
export {
  assertAllowedUrl,
  BLOCKED_ADDRESS_RULES,
  createGuardedLookup,
  createSafeFetch,
  isBlockedAddress,
  safeFetch,
} from "./url-safety.ts";
export type {
  BlockedAddressRule,
  GuardedLookup,
  ResolveHost,
  ResolvedAddress,
  SafeFetch,
  SafeFetchInit,
  UrlSafetyOptions,
} from "./url-safety.ts";
