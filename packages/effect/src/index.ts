export const moduleInfo = {
  name: "@porkbot/effect",
  summary: "Shared Effect layers, service tags and the transport error mapping.",
} as const;

// The typed errors the `Cause -> ORPCError` table maps. They are declared here,
// not beside their throw sites, so the mapping can name them without importing
// `@porkbot/db` (the module map keeps that edge out of this package).
export {
  CredentialMissingError,
  DeploymentSettingsConflictError,
  NotFoundError,
} from "./errors.ts";
