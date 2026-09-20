import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createMcpController } from "./mcp.ts";
import type { McpController, McpInstallInput, McpState, McpTransport } from "./mcp.ts";

/**
 * The React binding for the MCP settings surface: the controller is created
 * from the transport, loaded once on mount, and its state is read through
 * `useSyncExternalStore`. The transport is stable for the life of the route,
 * so the controller is created once and a re-render never restarts a read.
 */

export interface UseMcpOptions {
  readonly transport: McpTransport;
}

export interface UseMcpResult {
  readonly state: McpState;
  readonly load: () => void;
  readonly open: (id: string) => Promise<void>;
  readonly close: () => void;
  readonly install: (input: McpInstallInput) => Promise<boolean>;
  readonly remove: (id: string) => Promise<void>;
  readonly grant: (botId: string) => Promise<void>;
  readonly revokeGrant: (botId: string) => Promise<void>;
  readonly recheck: () => Promise<void>;
}

export function useMcp(options: UseMcpOptions): UseMcpResult {
  const { transport } = options;
  const controller: McpController = useMemo(() => createMcpController({ transport }), [transport]);

  useEffect(() => {
    controller.load();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);

  return {
    state,
    load: controller.load,
    open: controller.open,
    close: controller.close,
    install: controller.install,
    remove: controller.remove,
    grant: controller.grant,
    revokeGrant: controller.revokeGrant,
    recheck: controller.recheck,
  };
}
