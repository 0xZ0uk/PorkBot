export const moduleInfo = {
  name: "@porkbot/contracts",
  summary:
    "Schemas and transport types. The single source of transport truth: procedures, their typed errors, and the client type derived from the contract.",
} as const;

// The contract tree: input and output schemas for every procedure. The API
// implements this object and no other package may declare a transport type of
// its own (PRD decisions 14 and 15).
export { appContract } from "./contract.ts";
export type { AppContract } from "./contract.ts";
export { deploymentStatusContract, signupAvailabilitySchema } from "./deployment.ts";
export type { SignupAvailability } from "./deployment.ts";

// The client: a type derived from the contract plus the factory that builds it.
export { createApiClient } from "./client.ts";
export type { ApiClientOptions, AppClient } from "./client.ts";
