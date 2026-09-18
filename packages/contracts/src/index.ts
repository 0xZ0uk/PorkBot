export const moduleInfo = {
  name: "@porkbot/contracts",
  summary:
    "Schemas and transport types. The single source of transport truth: procedures, their typed errors, and the client type derived from the contract.",
} as const;

// The contract tree: input and output schemas for every procedure. The API
// implements this object and no other package may declare a transport type of
// its own (PRD decisions 14 and 15).
export { appContract, publicProcedures } from "./contract.ts";
export type { AppContract } from "./contract.ts";

// Access: authenticated by default, public only when a contract says so. The
// gate in the API reads this metadata; `access.test.ts` walks the tree and
// fails when a procedure carries no marker or the public list drifts.
export { authenticatedProcedure, procedureAccessSchema, publicProcedure } from "./access.ts";
export type { ProcedureAccess, ProcedureMeta } from "./access.ts";

export { deploymentStatusContract, signupAvailabilitySchema } from "./deployment.ts";
export type { SignupAvailability } from "./deployment.ts";

export { accountMeContract, memberRoleSchema } from "./account.ts";
export type { MemberRole } from "./account.ts";

export { botsGetContract, botSchema } from "./bots.ts";
export type { Bot } from "./bots.ts";

// The client: a type derived from the contract plus the factory that builds it.
export { createApiClient } from "./client.ts";
export type { ApiClientOptions, AppClient } from "./client.ts";
