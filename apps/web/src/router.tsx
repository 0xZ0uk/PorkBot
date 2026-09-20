import { createRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { BootstrappingScreen } from "./screens/bootstrapping.tsx";
import { createSessionController } from "./session.ts";
import {
  createHttpAuthTransport,
  createHttpApprovalTransport,
  createHttpBotsTransport,
  createHttpComputerTransport,
  createHttpConnectionsTransport,
  createHttpConsoleTransport,
  createHttpMcpTransport,
  createHttpMemoryTransport,
  createHttpNotificationsTransport,
  createHttpOwnershipTransport,
  createHttpSecretsTransport,
  createHttpUsageTransport,
} from "./transport.ts";
import type { ComputerTransport } from "./computer.ts";
import type { ConnectionsTransport } from "./connections.ts";
import type { BotsTransport } from "./bots.ts";
import type { McpTransport } from "./mcp.ts";
import type { MemoryTransport } from "./memory.ts";
import type { NotificationsTransport } from "./notifications.ts";
import type { OwnershipTransport } from "./ownership.ts";
import type { SecretsTransport } from "./secrets.ts";
import type { AuthTransport, SessionController } from "./session.ts";
import type { ApprovalTransport, ConsoleTransport, UsageTransport } from "./transport.ts";

/**
 * The router and the things every route may read from its context: the
 * session controller and the transports each screen reads through. `getRouter`
 * is the export TanStack Start looks for in this file, and it is also what a
 * test can call with fakes and a memory history, so the guards, the console
 * and the settings screens are exercised without a browser or a network.
 */
export interface RouterContext {
  readonly session: SessionController;
  readonly auth: AuthTransport;
  /** Bot CRUD, sections, avatars and computer health for the product home. */
  readonly bots: BotsTransport;
  /** The console's data surface: bots, threads and one thread's stream. */
  readonly threads: ConsoleTransport;
  /** The memory screen's data surface: documents, history and the operator's writes. */
  readonly memory: MemoryTransport;
  /** The usage screen's data surface: one bot's totals and daily buckets. */
  readonly usage: UsageTransport;
  /** The connections screen's data surface: connections, keys, bots and the probe. */
  readonly connections: ConnectionsTransport;
  /** The computer settings screen's data surface: providers, one machine and its snapshots. */
  readonly computer: ComputerTransport;
  /** Pending approvals and durable approval history for the signed-in actor. */
  readonly approvals?: ApprovalTransport;
  /** The notification settings surface's data: the operator's switches. */
  readonly notifications?: NotificationsTransport;
  /** The account settings surface's data: the actor's role and the deployment owner. */
  readonly ownership?: OwnershipTransport;
  /** The secrets settings surface's data: bots and their stored secrets. */
  readonly secrets?: SecretsTransport;
  /** The MCP settings surface's data: servers, tools and per-bot grants. */
  readonly mcp?: McpTransport;
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
    bots: createHttpBotsTransport(),
    session: createSessionController({ transport: auth }),
    threads: createHttpConsoleTransport(),
    memory: createHttpMemoryTransport(),
    usage: createHttpUsageTransport(),
    connections: createHttpConnectionsTransport(),
    computer: createHttpComputerTransport(),
    approvals: createHttpApprovalTransport(),
    notifications: createHttpNotificationsTransport(),
    ownership: createHttpOwnershipTransport(),
    secrets: createHttpSecretsTransport(),
    mcp: createHttpMcpTransport(),
  });
}
