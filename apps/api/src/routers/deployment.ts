import { appImplementer } from "./context.ts";
import type { DeploymentStatusService } from "../services/deployment.ts";

/**
 * The deployment router: one screen, no business logic. It asks the service
 * for an outcome and turns "misconfigured" into the contract's typed error;
 * the open/closed mapping is the service's job, and validation is the
 * contract's (the handler sees parsed input and returns the declared output).
 */
export function createDeploymentRouter(service: DeploymentStatusService) {
  const status = appImplementer.deployment.status.handler(async ({ errors }) => {
    const result = await service.status();

    if (result.kind === "misconfigured") {
      throw errors.SERVICE_UNAVAILABLE();
    }

    return { signups: result.kind };
  });

  return appImplementer.deployment.router({ status });
}
