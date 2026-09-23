import { integration } from "@porkbot/testkit";

// The deployment tier: what a supervisor slice can only prove against the real
// thing. The specs here inspect the running local stack (the socket is mounted
// where compose says it is) and drive real Docker networks and containers to
// show the isolation policy behaves. CI starts the stack with `pnpm stack:up`
// before this tier runs, which is why the stack specs can assert instead of
// skipping.
const config = integration({ include: ["test/integration/**/*.integration.test.ts"] });

export default {
  ...config,
  test: {
    ...config.test,
    fileParallelism: false,
  },
};
