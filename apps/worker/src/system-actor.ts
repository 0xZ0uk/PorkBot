import type { SystemActor } from "@porkbot/db";

/**
 * A job's scope — the job id and the space its payload names. The worker has no
 * session and no user, so it acts through a `SystemActor`: the repository layer
 * scopes every statement to this space and nothing in the worker ever holds a
 * repository that spans spaces. Graphile owns the job queue; this type is what
 * the job handler carries into the data layer (PRD decisions 7 and 17).
 */
export interface JobScope {
  readonly jobId: string;
  readonly spaceId: string;
}

export function systemActorForJob(job: JobScope): SystemActor {
  return { kind: "system", spaceId: job.spaceId, jobId: job.jobId };
}
