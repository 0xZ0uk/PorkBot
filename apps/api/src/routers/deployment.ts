import { publicOnly } from "../gate.ts";
import type { DeploymentStatusService } from "../services/deployment.ts";

/**
 * The deployment router: one screen, no business logic. It asks the service
 * for an outcome and turns "misconfigured" into the contract's typed error;
 * the open/closed mapping is the service's job, and validation is the
 * contract's (the handler sees parsed input and returns the declared output).
 *
 * `deployment.status` is the contract's one public procedure, so it registers
 * on `publicOnly`; the middleware fails closed if the contract ever stops
 * marking it public.
 */
export function createDeploymentRouter(service: DeploymentStatusService) {
  const status = publicOnly.deployment.status.handler(async ({ errors }) => {
    const result = await service.status();

    if (result.kind === "misconfigured") {
      throw errors.SERVICE_UNAVAILABLE();
    }

    return { signups: result.kind };
  });

  return publicOnly.deployment.router({ status });
}
