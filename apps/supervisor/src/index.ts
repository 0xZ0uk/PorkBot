export const moduleInfo = {
  name: "@porkbot/supervisor",
  summary:
    "The only holder of the Docker socket and the only owner of computer lifecycle: boot, stop, reset, recover, isolation and reconciliation.",
} as const;

// The lifecycle surface: the four operations this process owns, plus the
// primitives a caller reaches through the authenticated client in
// `@porkbot/adapters`. Nothing outside this process constructs a provider.
export { createComputerLifecycle } from "./computer-lifecycle.ts";
export type {
  ComputerLifecycle,
  ComputerLifecycleOptions,
  ReconciliationReport,
} from "./computer-lifecycle.ts";

// The internal HTTP surface: one door to every computer, guarded by the
// process credential, with the reserved screen paths guarded by a short-lived
// capability token the API will mint when screen watch ships in v1.1.
export {
  createSupervisorServer,
  supervisorMaxCommandLength,
  supervisorMaxExecTimeoutMs,
} from "./server.ts";
export type { SupervisorServerOptions } from "./server.ts";

// The shared wire limit: the same byte cap the client applies to an answer.
export { supervisorMaxBodyBytes } from "@porkbot/adapters";
