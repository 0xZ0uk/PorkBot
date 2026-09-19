import { createRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { BootstrappingScreen } from "./screens/bootstrapping.tsx";
import { createSessionController } from "./session.ts";
import {
  createHttpAuthTransport,
  createHttpConsoleTransport,
  createHttpMemoryTransport,
} from "./transport.ts";
import type { MemoryTransport } from "./memory.ts";
import type { AuthTransport, SessionController } from "./session.ts";
import type { ConsoleTransport } from "./transport.ts";

/**
 * The router and the things every route may read from its context: the
 * session controller, the auth transport, the console transport and the memory
 * transport. `getRouter` is the export TanStack Start looks for in this file,
 * and it is also what a test can call with fakes and a memory history, so the
 * guards, the console and the memory screen are exercised without a browser or
 * a network.
 */
export interface RouterContext {
  readonly session: SessionController;
  readonly auth: AuthTransport;
  /** The console's data surface: bots, threads and one thread's stream. */
  readonly threads: ConsoleTransport;
  /** The memory screen's data surface: documents, history and the operator's writes. */
  readonly memory: MemoryTransport;
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

  return createAppRouter({
    auth,
    session: createSessionController({ transport: auth }),
    threads: createHttpConsoleTransport(),
    memory: createHttpMemoryTransport(),
  });
}
