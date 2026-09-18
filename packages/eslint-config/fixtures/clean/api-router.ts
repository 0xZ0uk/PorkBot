import { authenticated, publicOnly } from "./gate.ts";

// A gated router: procedures come from the implementers the gate exports, so
// the auth-gate rule stays silent and the default stays authenticated.
export const account = authenticated.account.router({});
export const deployment = publicOnly.deployment.router({});
