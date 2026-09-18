import { implement } from "@orpc/server";
import { appContract } from "@porkbot/contracts";
import type { Logger } from "@porkbot/logging";

/**
 * The per-request context every procedure handler can rely on. It is built
 * from the request's correlation id and logger, so a handler that logs, or a
 * service it calls, joins the request's lines instead of inventing a second
 * correlation id.
 */
export interface ProcedureContext {
  readonly logger: Logger;
  readonly requestId: string;
}

/**
 * The one implementer of the application contract. Routers are built from it
 * so `implement(contract)` is called once, the contract stays the only source
 * of procedure shapes, and the root router assembled in `app.ts` is checked
 * against the same contract at compile time.
 */
export const appImplementer = implement(appContract).$context<ProcedureContext>();
