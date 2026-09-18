import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract } from "./contract.ts";

/**
 * The typed client, derived from the application contract rather than written
 * beside it. `ContractRouterClient` walks the contract tree, so a procedure
 * added in `contract.ts` appears here with its input, output and typed errors
 * and no manual step touches this file (PRD decisions 14 and 15).
 *
 * The client is a type and a thin factory, not a second schema layer: every
 * call is validated by the server against the same contract, and the response
 * the client returns is the contract's output type.
 */
export type AppClient = ContractRouterClient<AppContract>;

export interface ApiClientOptions {
  /**
   * Base URL of the RPC endpoint, e.g. `https://porkbot.example/rpc` or
   * `/rpc` for a same-origin SPA.
   */
  readonly url: string | URL;
}

/** Builds a client for the API's RPC endpoint. */
export function createApiClient(options: ApiClientOptions): AppClient {
  return createORPCClient<AppClient>(new RPCLink({ url: options.url }));
}
