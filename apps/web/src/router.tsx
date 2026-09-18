import { createRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { BootstrappingScreen } from "./screens/bootstrapping.tsx";
import { createSessionController } from "./session.ts";
import { createHttpAuthTransport } from "./transport.ts";
import type { AuthTransport, SessionController } from "./session.ts";

/**
 * The router and the two things every route may read from its context: the
 * session controller and the transport. `getRouter` is the export TanStack
 * Start looks for in this file, and it is also what a test can call with fakes
 * and a memory history, so the guards are exercised without a browser or a
 * network.
 */
export interface RouterContext {
  readonly session: SessionController;
  readonly auth: AuthTransport;
}

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...(history === undefined ? {} : { history }),
    // The bootstrapping state. While a guard awaits the session read the router
    // renders this instead of the matched route, which is what makes "checking"
    // a state a person can see rather than a blank document.
    defaultPendingComponent: BootstrappingScreen,
    scrollRestoration: true,
  });
}

/** The composition root for the browser; tests pass their own deps instead. */
export function getRouter() {
  const auth = createHttpAuthTransport();

  return createAppRouter({ auth, session: createSessionController({ transport: auth }) });
}
