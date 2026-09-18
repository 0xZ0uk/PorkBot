import { deploymentStatusContract } from "./deployment.ts";

/**
 * The application contract: the one source of transport truth (PRD decision
 * 15). Every procedure's input, output and typed errors live here, the API
 * implements this object, and clients consume it through the derived router
 * type in `client.ts`. Adding a procedure is an edit to this tree; the client
 * type, the server's compile-time completeness check and the OpenAPI document
 * all follow from it without a hand-written duplicate at any boundary.
 */
export const appContract = {
  deployment: {
    status: deploymentStatusContract,
  },
};

export type AppContract = typeof appContract;
