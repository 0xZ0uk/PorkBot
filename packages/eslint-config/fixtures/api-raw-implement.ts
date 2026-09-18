import { implement } from "@orpc/server";
import { appContract } from "@porkbot/contracts";

// Deliberately wrong: a router that registers the whole contract through
// `implement` itself, off the auth gate. `no-restricted-syntax` must fire.
export const router = implement(appContract);
