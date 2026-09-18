export const moduleInfo = {
  name: "@porkbot/effect",
  summary: "Shared Effect layers, service tags and the transport error mapping.",
} as const;

// The typed errors the `Cause -> ORPCError` table maps. They are declared here,
// not beside their throw sites, so the mapping can name them without importing
// `@porkbot/db` (the module map keeps that edge out of this package).
export {
  BlockedUrlError,
  CredentialMissingError,
  DeploymentSettingsConflictError,
  NotFoundError,
} from "./errors.ts";
export type { BlockedUrlReason } from "./errors.ts";

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
