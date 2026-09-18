import { moduleInfo as core } from "@porkbot/core";
import { moduleInfo as db } from "@porkbot/db";
import { moduleInfo as effect } from "@porkbot/effect";
import { moduleInfo as logging } from "@porkbot/logging";

export const moduleInfo = {
  name: "@porkbot/worker",
  summary: "Always-on background worker. Graphile Worker owns durable jobs.",
} as const;

export const workerModules = [core.name, db.name, effect.name, logging.name] as const;

// The job registry: one identifier, one parser and one handler per durable job,
// with the queue-versus-fence division stated in that module. `startWorker`
// boots Graphile over the registry; `main.ts` is the only composition root.
export { createJobRegistry, defineJob, JobPayloadError } from "./job-registry.ts";
export type {
  JobContext,
  JobDefinition,
  JobRegistry,
  JobRegistryOptions,
  RegisteredJob,
} from "./job-registry.ts";

// The run-execute job: the payload addresses a run and carries a fence, and the
// handler re-reads the row through the payload's `SystemActor` before anything
// is allowed to happen. The executor is the slice 6.2 seam.
export { parseRunExecutePayload, runExecuteIdentifier, runExecuteJob } from "./jobs/run-execute.ts";
export type { RunExecutePayload, RunExecution, RunExecutor } from "./jobs/run-execute.ts";

export { systemActorForJob } from "./system-actor.ts";
export type { JobScope } from "./system-actor.ts";
export { startWorker } from "./worker.ts";
export type { WorkerOptions } from "./worker.ts";
