import { e2e } from "@porkbot/testkit";

// The e2e tier: whole-process tests against the built output. It is the only
// tier allowed to retry (twice), because a spawned process, a port and a socket
// can genuinely race; every retry is reported by the shared flake reporter.
export default e2e({ include: ["test/e2e/**/*.test.{ts,tsx}"] });
