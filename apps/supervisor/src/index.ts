export const moduleInfo = {
  name: "@porkbot/supervisor",
  summary:
    "The only holder of the Docker socket and the only owner of computer lifecycle: boot, stop, reset, recover, idle shutdown, isolation and reconciliation.",
} as const;

// The lifecycle surface: the four operations this process owns, plus the
// primitives a caller reaches through the authenticated client in
// `@porkbot/adapters`, plus the idle sweep that parks a machine no run is
// using. Nothing outside this process constructs a provider.
export { createComputerLifecycle } from "./computer-lifecycle.ts";
export type {
  ComputerLifecycle,
  ComputerLifecycleOptions,
  IdleStopReport,
  ReconciliationReport,
} from "./computer-lifecycle.ts";

// Which computer provider the process owns, and its ceilings, resolved from
// the generic computer settings in the environment. The offline default keeps
// the local stack daemon-free; the Docker selection is the deployment's real
// machine and fails closed when it is not configured.
export { createComputerProviderSelection, DEFAULT_IDLE_TIMEOUT_MS } from "./computer-provider.ts";
export type { ComputerProviderSelection } from "./computer-provider.ts";

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
