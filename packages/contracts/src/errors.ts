import { ORPCError } from "@orpc/client";

/**
 * The oRPC error class, re-exported so the one `Cause -> ORPCError` table in
 * `@porkbot/effect` (PRD decision 28) can construct the transport envelope
 * without reaching for `@orpc/client` itself. The module map gives that library
 * to `@porkbot/contracts` alone, because the contract is the single source of
 * transport types; this export is how a shared layer reaches the one class the
 * contract's error envelopes are built from.
 *
 * The class is the same value `@orpc/server` uses: oRPC warns that two copies
 * of it break `instanceof`, and a single pinned version keeps both imports on
 * one constructor.
 */
export { ORPCError };
